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

// CORS: required for Expo Go on iPhone + Render
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // Preflight support

// Helper timestamp
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

    if (!name || !createdBy)
      return res.status(400).json({ error: "Missing required fields" });

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
// 🟢 UNIFIED + SAFER PING ENDPOINT
// POST /api/events/:eventId/ping
// - Logs ping
// - Calculates split
// - Updates athlete progress + checkpointTimes
// - Prevents double pings / skipping / backwards
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
    const currentProgress =
      typeof athleteData.progress === "number" ? athleteData.progress : -1;

    // Optional: require athlete to be assigned to a wave
    if (!athleteData.wave && athleteData.wave !== 0) {
      // If you don't want this strict, comment this out
      // return res.status(400).json({ error: "Athlete has no wave assigned" });
    }

    // 3. Prevent backwards or skipping too far
    // - Can't go backwards
    if (checkpointIndex < currentProgress) {
      return res.status(400).json({
        error: "Backward ping not allowed",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    // - Can't ping same checkpoint again (double tap protection)
    if (checkpointIndex === currentProgress) {
      return res.status(409).json({
        error: "Duplicate ping for this checkpoint",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    // - Can't jump ahead more than one checkpoint
    if (checkpointIndex > currentProgress + 1) {
      return res.status(400).json({
        error: "Cannot skip checkpoints",
        currentProgress,
        attempted: checkpointIndex,
      });
    }

    const now = serverTimestamp();

    // 4. EXTRA double-ping safety: check if a ping already exists
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

    // 6. Find previous ping (for split calculation)
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

        // 7. Save split
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

    // 8. Update athlete progress + checkpointTimes
    await athleteRef.set(
      {
        progress: checkpointIndex,
        [`checkpointTimes.${checkpointIndex}`]: now,
        lastUpdatedAt: now,
      },
      { merge: true }
    );

    res.json({
      ok: true,
      pingId: pingRef.id,
      progress: checkpointIndex,
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

    // Add rank
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
// - Uses athlete progress + checkpointTimes + splits
// - Ranks by:
//   1) Highest progress
//   2) Lowest totalMs (if available)
//   3) Earliest last checkpoint time
// ------------------------------------------------------------
app.get("/api/events/:eventId/leaderboard", async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventRef = db.collection("events").doc(eventId);

    // 1. Get all athletes for the event
    const athletesSnap = await eventRef.collection("athletes").get();
    const athletes = [];
    const athleteMap = {};

    athletesSnap.forEach((doc) => {
      const data = doc.data();
      const id = doc.id;
      const progress =
        typeof data.progress === "number" ? data.progress : -1;
      const checkpointTimes = data.checkpointTimes || {};
      let lastTimeMs = null;

      if (progress >= 0 && checkpointTimes[progress]) {
        lastTimeMs = checkpointTimes[progress].toMillis();
      }

      const base = {
        athleteId: id,
        name: data.name || "",
        wave: data.wave ?? null,
        progress,
        checkpointTimes,
        lastTimeMs,
      };

      athletes.push(base);
      athleteMap[id] = base;
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

    // 3. Build leaderboard array
    let leaderboard = athletes.map((a) => ({
      ...a,
      totalMs: totals[a.athleteId] ?? null,
    }));

    // 4. Sort:
    // - highest progress first
    // - then lowest totalMs
    // - then earliest lastTimeMs
    leaderboard.sort((a, b) => {
      if (b.progress !== a.progress) {
        return b.progress - a.progress;
      }

      // both same progress
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

    // 5. Add rank
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
