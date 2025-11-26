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
const FieldValue = admin.firestore.FieldValue;

// ------------------------------
// EXPRESS APP SETUP
// ------------------------------
const app = express();
app.use(express.json());

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // Preflight

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
// PING ENDPOINT (Start/Next/End Station)
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

    // Get event
    const eventRef = db.collection("events").doc(eventId);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) return res.status(404).json({ error: "Event not found" });
    if (eventSnap.data().status !== "active") {
      return res.status(400).json({ error: "Event not active" });
    }

    // Get athlete
    const athleteRef = eventRef.collection("athletes").doc(athleteId);
    const athleteSnap = await athleteRef.get();
    if (!athleteSnap.exists) return res.status(404).json({ error: "Athlete not found" });
    const athleteData = athleteSnap.data();

    let progress = typeof athleteData.progress === "number" ? athleteData.progress : 0;

    // Validation
    if (checkpointIndex < progress)
      return res.status(400).json({ error: "Backward ping not allowed", currentProgress: progress });

    if (checkpointIndex > progress)
      return res.status(400).json({ error: "Cannot skip checkpoints", currentProgress: progress });

    // Check for duplicates
    const dupPing = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("checkpointIndex", "==", checkpointIndex)
      .limit(1)
      .get();

    if (!dupPing.empty) {
      return res.status(409).json({
        error: "Duplicate ping for this checkpoint",
        currentProgress: progress,
        attempted: checkpointIndex,
      });
    }

    const now = serverTimestamp();

    // Write ping
    await db.collection("pings").add({
      eventId,
      athleteId,
      checkpointIndex,
      timestamp: now,
    });

    // Split calculation
    let durationMs = null;

    if (checkpointIndex > 0) {
      const prev = await db
        .collection("pings")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("checkpointIndex", "==", checkpointIndex - 1)
        .limit(1)
        .get();

      if (!prev.empty) {
        const prevData = prev.docs[0].data();
        durationMs = now.toMillis() - prevData.timestamp.toMillis();

        await db.collection("splits").add({
          eventId,
          athleteId,
          segmentIndex: checkpointIndex,
          startTimestamp: prevData.timestamp,
          endTimestamp: now,
          durationMs,
        });
      }
    }

    // Update athlete progress
    await athleteRef.set(
      {
        progress: checkpointIndex + 1,
        [`checkpointTimes.${checkpointIndex}`]: now,
        lastUpdatedAt: now,
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      progress: checkpointIndex + 1,
      splitMs: durationMs,
    });
  } catch (err) {
    console.error("❌ Error in ping:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// ADMIN: UNDO LAST STATION (No time lost)
// ------------------------------------------------------------
app.post("/api/events/:eventId/athletes/:athleteId/undo", async (req, res) => {
  try {
    const { eventId, athleteId } = req.params;

    const eventRef = db.collection("events").doc(eventId);
    const athleteRef = eventRef.collection("athletes").doc(athleteId);

    const athSnap = await athleteRef.get();
    if (!athSnap.exists) return res.status(404).json({ error: "Athlete not found" });

    const data = athSnap.data();
    const progress = typeof data.progress === "number" ? data.progress : 0;

    if (progress <= 0) {
      return res.status(400).json({ error: "No station to undo", progress });
    }

    const undoIndex = progress - 1;

    // Delete ping
    const pingsSnap = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("checkpointIndex", "==", undoIndex)
      .get();

    const batch = db.batch();
    pingsSnap.forEach((doc) => batch.delete(doc.ref));

    // Delete split
    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("segmentIndex", "==", undoIndex)
      .get();

    splitsSnap.forEach((doc) => batch.delete(doc.ref));

    // Remove finished timestamp but keep start time
    batch.set(
      athleteRef,
      {
        progress: undoIndex,
        [`checkpointTimes.${undoIndex}`]: FieldValue.delete(),
        lastUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();

    return res.json({ ok: true, newProgress: undoIndex });
  } catch (err) {
    console.error("❌ Undo error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// ADMIN: SET PROGRESS MANUALLY
// ------------------------------------------------------------
app.post("/api/events/:eventId/athletes/:athleteId/set-progress", async (req, res) => {
  try {
    const { eventId, athleteId } = req.params;
    const { progress } = req.body;

    if (typeof progress !== "number")
      return res.status(400).json({ error: "Invalid progress" });

    const athleteRef = db
      .collection("events")
      .doc(eventId)
      .collection("athletes")
      .doc(athleteId);

    await athleteRef.set(
      {
        progress,
        lastUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, progress });
  } catch (err) {
    console.error("❌ Error set-progress:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// ADMIN: RESET ATHLETE
// ------------------------------------------------------------
app.post("/api/events/:eventId/athletes/:athleteId/reset", async (req, res) => {
  try {
    const { eventId, athleteId } = req.params;

    const athleteRef = db
      .collection("events")
      .doc(eventId)
      .collection("athletes")
      .doc(athleteId);

    const batch = db.batch();

    // Delete pings
    const pingsSnap = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .get();
    pingsSnap.forEach((doc) => batch.delete(doc.ref));

    // Delete splits
    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .get();
    splitsSnap.forEach((doc) => batch.delete(doc.ref));

    // Reset athlete
    batch.set(
      athleteRef,
      {
        progress: -1,
        checkpointTimes: {},
        lastUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error reset:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// ADMIN: DISQUALIFY ATHLETE (DNF)
// ------------------------------------------------------------
app.post("/api/events/:eventId/athletes/:athleteId/disqualify", async (req, res) => {
  try {
    const { eventId, athleteId } = req.params;

    const athleteRef = db
      .collection("events")
      .doc(eventId)
      .collection("athletes")
      .doc(athleteId);

    await athleteRef.set(
      {
        status: "dnf",
        lastUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, status: "dnf" });
  } catch (err) {
    console.error("❌ Error disqualify:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// RESULTS
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
    console.error("❌ Error results:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// LEADERBOARD
// ------------------------------------------------------------
app.get("/api/events/:eventId/leaderboard", async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventRef = db.collection("events").doc(eventId);
    const athletesSnap = await eventRef.collection("athletes").get();

    let athletes = [];

    athletesSnap.forEach((doc) =>
      athletes.push({
        athleteId: doc.id,
        ...doc.data(),
      })
    );

    // Add totalMs
    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const totals = {};
    splitsSnap.forEach((doc) => {
      const data = doc.data();
      totals[data.athleteId] =
        (totals[data.athleteId] || 0) + (data.durationMs || 0);
    });

    athletes = athletes.map((a) => ({
      ...a,
      totalMs: totals[a.athleteId] ?? null,
    }));

    // Ranking logic
    athletes.sort((a, b) => {
      if ((b.progress ?? 0) !== (a.progress ?? 0)) {
        return (b.progress ?? 0) - (a.progress ?? 0);
      }
      if (a.totalMs != null && b.totalMs != null) {
        return a.totalMs - b.totalMs;
      }
      return 0;
    });

    athletes = athletes.map((a, idx) => ({ ...a, rank: idx + 1 }));

    res.json({ leaderboard: athletes });
  } catch (err) {
    console.error("❌ Error leaderboard:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TYMX backend running on port ${PORT}`);
});
