import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// ------------------------------
// LOAD FIREBASE SERVICE ACCOUNT
// ------------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT env var missing!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ------------------------------
// EXPRESS APP SETUP
// ------------------------------
const app = express();
app.use(express.json());

// CORS for Expo + Render
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // Preflight

// Helper
const serverTimestamp = () => admin.firestore.Timestamp.now();

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "TYMX backend running (Render)" });
});

// ------------------------------
// CREATE EVENT
// ------------------------------
app.post("/api/events", async (req, res) => {
  try {
    const { name, createdBy, gymId, totalCheckpoints, stationList } = req.body;

    if (!name || !createdBy) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const docRef = await db.collection("events").add({
      name,
      gymId: gymId || null,
      createdBy,
      status: "upcoming",
      startsAt: null,
      endsAt: null,
      totalCheckpoints: totalCheckpoints || 0,
      stationList: stationList || [],
      createdAt: serverTimestamp(),
    });

    res.json({ eventId: docRef.id });
  } catch (err) {
    console.error("❌ Error creating event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// START EVENT
// ------------------------------
app.post("/api/events/:eventId/start", async (req, res) => {
  try {
    const { eventId } = req.params;

    await db.collection("events").doc(eventId).update({
      status: "active",
      startsAt: serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error starting event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// STOP EVENT
// ------------------------------
app.post("/api/events/:eventId/stop", async (req, res) => {
  try {
    const { eventId } = req.params;

    await db.collection("events").doc(eventId).update({
      status: "completed",
      endsAt: serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error stopping event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// UNIFIED + SAFE PING ENDPOINT
// POST /api/events/:eventId/ping
// ------------------------------------------------------------
app.post("/api/events/:eventId/ping", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { athleteId, checkpointIndex } = req.body;

    if (!athleteId || checkpointIndex === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (typeof checkpointIndex !== "number" || checkpointIndex < 0) {
      return res.status(400).json({ error: "Invalid checkpointIndex" });
    }

    // 1. Load event and ensure it's active
    const eventRef = db.collection("events").doc(eventId);
    const eventSnap = await eventRef.get();

    if (!eventSnap.exists) {
      return res.status(404).json({ error: "Event not found" });
    }

    const eventData = eventSnap.data();
    if (eventData.status !== "active") {
      return res
        .status(400)
        .json({ error: "Event is not active; cannot accept pings" });
    }

    // 2. Load athlete
    const athleteRef = eventRef.collection("athletes").doc(athleteId);
    const athleteSnap = await athleteRef.get();

    if (!athleteSnap.exists) {
      return res.status(404).json({ error: "Athlete not found" });
    }

    const athleteData = athleteSnap.data() || {};

    // Treat progress as "index of next checkpoint to ping"
    let currentProgress = 0;
    if (typeof athleteData.progress === "number") {
      currentProgress = athleteData.progress;
    } else if (typeof athleteData.currentCheckpoint === "number") {
      // fallback for legacy data
      currentProgress = athleteData.currentCheckpoint;
    }

    // Optional: require athlete wave
    if (!athleteData.wave && athleteData.wave !== 0) {
      // uncomment if you want to enforce waves:
      // return res.status(400).json({ error: "Athlete has no wave assigned" });
    }

    // 3. Validation:
    // - must ping EXACTLY the currentProgress checkpoint
    // - less than that = backwards
    // - greater than that = skipping
    if (checkpointIndex < currentProgress) {
      return res.status(400).json({
        error: "Backward ping not allowed",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    if (checkpointIndex > currentProgress) {
      return res.status(400).json({
        error: "Cannot skip checkpoints",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    const now = serverTimestamp();

    // 4. Extra double-ping safety based on existing ping docs
    const duplicateSnap = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("checkpointIndex", "==", checkpointIndex)
      .limit(1)
      .get();

    if (!duplicateSnap.empty) {
      return res.status(409).json({
        error: "Duplicate ping document already exists",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    // 5. Save ping
    const pingRef = await db.collection("pings").add({
      eventId,
      athleteId,
      checkpointIndex,
      timestamp: now,
    });

    // 6. Find previous ping for split calculation
    let durationMs = null;
    if (checkpointIndex > 0) {
      const prevPingSnap = await db
        .collection("pings")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("checkpointIndex", "==", checkpointIndex - 1)
        .orderBy("checkpointIndex", "desc")
        .limit(1)
        .get();

      if (!prevPingSnap.empty) {
        const prev = prevPingSnap.docs[0].data();
        durationMs = now.toMillis() - prev.timestamp.toMillis();

        await db.collection("splits").add({
          eventId,
          athleteId,
          segmentIndex: checkpointIndex,
          startTimestamp: prev.timestamp,
          endTimestamp: now,
          durationMs,
        });
      }
    }

    // 7. Update athlete:
    //    - set checkpointTimes[checkpointIndex]
    //    - advance progress to NEXT checkpoint
    await athleteRef.set(
      {
        progress: currentProgress + 1,
        [`checkpointTimes.${checkpointIndex}`]: now,
        lastUpdatedAt: now,
      },
      { merge: true }
    );

    res.json({
      ok: true,
      pingId: pingRef.id,
      progress: currentProgress + 1,
      splitMs: durationMs,
    });
  } catch (err) {
    console.error("❌ Error in /events/:eventId/ping:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// GET EVENT RESULTS (FINISHED TIMES + RANK)
// ------------------------------------------------------------
app.get("/api/events/:eventId/results", async (req, res) => {
  try {
    const { eventId } = req.params;

    const snap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const resultsMap = {};

    snap.forEach((doc) => {
      const data = doc.data();
      if (!resultsMap[data.athleteId]) {
        resultsMap[data.athleteId] = {
          athleteId: data.athleteId,
          totalMs: 0,
          splits: [],
        };
      }
      resultsMap[data.athleteId].totalMs += data.durationMs || 0;
      resultsMap[data.athleteId].splits.push(data);
    });

    let finalResults = Object.values(resultsMap).sort(
      (a, b) => a.totalMs - b.totalMs
    );

    finalResults = finalResults.map((r, idx) => ({
      ...r,
      rank: idx + 1,
    }));

    res.json({ results: finalResults });
  } catch (err) {
    console.error("❌ Error getting results:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// LIVE LEADERBOARD
// GET /api/events/:eventId/leaderboard
// ------------------------------------------------------------
app.get("/api/events/:eventId/leaderboard", async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventRef = db.collection("events").doc(eventId);

    // 1. Get all athletes
    const athletesSnap = await eventRef.collection("athletes").get();
    const athletes = [];

    athletesSnap.forEach((doc) => {
      const data = doc.data();
      const id = doc.id;
      const progress =
        typeof data.progress === "number" ? data.progress : 0;
      const checkpointTimes = data.checkpointTimes || {};
      let lastTimeMs = null;

      if (progress > 0 && checkpointTimes[progress - 1]) {
        lastTimeMs = checkpointTimes[progress - 1].toMillis();
      }

      athletes.push({
        athleteId: id,
        name: data.name || "",
        wave: data.wave ?? null,
        progress,
        checkpointTimes,
        lastTimeMs,
      });
    });

    // 2. Get totalMs per athlete from splits
    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const totals = {};
    splitsSnap.forEach((doc) => {
      const data = doc.data();
      if (!totals[data.athleteId]) totals[data.athleteId] = 0;
      totals[data.athleteId] += data.durationMs || 0;
    });

    // 3. Build leaderboard
    let leaderboard = athletes.map((a) => ({
      ...a,
      totalMs: totals[a.athleteId] ?? null,
    }));

    // 4. Sort
    leaderboard.sort((a, b) => {
      if (b.progress !== a.progress) {
        return b.progress - a.progress;
      }

      const aHasTotal = a.totalMs != null;
      const bHasTotal = b.totalMs != null;
      if (aHasTotal && bHasTotal && a.totalMs !== b.totalMs) {
        return a.totalMs - b.totalMs;
      }

      const aHasLast = a.lastTimeMs != null;
      const bHasLast = b.lastTimeMs != null;
      if (aHasLast && bHasLast && a.lastTimeMs !== b.lastTimeMs) {
        return a.lastTimeMs - b.lastTimeMs;
      }

      return 0;
    });

    leaderboard = leaderboard.map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));

    res.json({ leaderboard });
  } catch (err) {
    console.error("❌ Error getting leaderboard:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TYMX backend running on port ${PORT} (Render)`);
});
