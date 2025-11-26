import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// ------------------------------
// FIREBASE INIT
// ------------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT env var missing");
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
const serverTimestamp = () => admin.firestore.Timestamp.now();

// ------------------------------
// EXPRESS
// ------------------------------
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

// ------------------------------
// HEALTH CHECK
// ------------------------------
app.get("/", (req, res) => {
  res.send({ ok: true, message: "TYMX backend running" });
});

// ------------------------------
// CREATE EVENT
// ------------------------------
app.post("/api/events", async (req, res) => {
  try {
    const { name, createdBy, stationList } = req.body;

    if (!name || !createdBy) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Assign stable station IDs
    const normalizedStations = (stationList || []).map((s, idx) => ({
      id: s.id || `station-${idx}`,
      name: s.name || `Station ${idx + 1}`,
      type: s.type || null,
      detail: s.detail || null,
    }));

    const ref = await db.collection("events").add({
      name,
      createdBy,
      status: "upcoming",
      stationList: normalizedStations,
      totalCheckpoints: normalizedStations.length,
      startsAt: null,
      endsAt: null,
      createdAt: serverTimestamp(),
    });

    return res.json({ eventId: ref.id });
  } catch (err) {
    console.error("❌ Error creating event:", err);
    return res.status(500).json({ error: "Internal server error" });
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

    return res.json({ ok: true });
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

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error stopping event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// PING (complete current station)
// Body: { athleteId, stationId }
// ------------------------------------------------------------
app.post("/api/events/:eventId/ping", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { athleteId, stationId } = req.body;

    if (!athleteId || !stationId) {
      return res.status(400).json({ error: "Missing athleteId or stationId" });
    }

    // Fetch event
    const eventRef = db.collection("events").doc(eventId);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) {
      return res.status(404).json({ error: "Event not found" });
    }
    const eventData = eventSnap.data();

    if (eventData.status !== "active") {
      return res.status(400).json({ error: "Event not active" });
    }

    const stationList = eventData.stationList || [];
    const stationIndexMap = {};
    stationList.forEach((s, idx) => {
      stationIndexMap[s.id] = idx;
    });

    if (!(stationId in stationIndexMap)) {
      return res.status(400).json({ error: "Unknown stationId" });
    }

    // Fetch athlete
    const athleteRef = eventRef.collection("athletes").doc(athleteId);
    const athleteSnap = await athleteRef.get();
    if (!athleteSnap.exists) {
      return res.status(404).json({ error: "Athlete not found" });
    }
    const athleteData = athleteSnap.data();

    const status = athleteData.status || "ready";
    if (status === "dnf") {
      return res.status(400).json({ error: "Athlete is DNF" });
    }

    // Correct progress interpretation
    const progress =
      typeof athleteData.progress === "number" && athleteData.progress >= 0
        ? athleteData.progress
        : 0;

    const expectedStation =
      stationList[progress] || stationList[stationList.length - 1];

    const expectedId = expectedStation.id;

    // Enforce correct order (no out-of-order)
    if (stationId !== expectedId) {
      return res.status(400).json({
        error:
          "Out of order. Please complete stations in order or use admin tools.",
        expectedStationId: expectedId,
        attemptedStationId: stationId,
      });
    }

    const stationTimes = athleteData.stationTimes || {};

    // Prevent duplicate completion
    if (stationTimes[stationId]) {
      return res.status(409).json({
        error: "Station already completed",
        stationId,
      });
    }

    const now = serverTimestamp();
    const stationIndex = stationIndexMap[stationId];

    // Write ping
    await db.collection("pings").add({
      eventId,
      athleteId,
      stationId,
      stationIndex,
      timestamp: now,
    });

    // Compute split from previous station
    let durationMs = null;

    if (progress > 0) {
      const previousStation = stationList[progress - 1];
      const previousId = previousStation.id;
      const previousTime = stationTimes[previousId];

      if (previousTime) {
        durationMs = now.toMillis() - previousTime.toMillis();

        await db.collection("splits").add({
          eventId,
          athleteId,
          stationId,
          stationIndex,
          startTimestamp: previousTime,
          endTimestamp: now,
          durationMs,
        });
      }
    }

    const nextProgress = progress + 1;
    const isFinished = nextProgress >= stationList.length;

    const update = {
      progress: nextProgress,
      stationTimes: {
        ...(stationTimes || {}),
        [stationId]: now,
      },
      lastUpdatedAt: now,
    };

    if (isFinished) {
      update.status = "finished";
      update.finishedAt = now;
    } else if (status === "ready") {
      update.status = "active";
    }

    await athleteRef.set(update, { merge: true });

    return res.json({
      ok: true,
      progress: nextProgress,
      stationId,
      stationIndex,
      splitMs: durationMs,
      finished: isFinished,
    });
  } catch (err) {
    console.error("❌ Error ping:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// UNDO LAST STATION (corrected, no ghost stationTimes)
// ------------------------------------------------------------
app.post(
  "/api/events/:eventId/athletes/:athleteId/undo",
  async (req, res) => {
    try {
      const { eventId, athleteId } = req.params;

      const eventRef = db.collection("events").doc(eventId);
      const eventSnap = await eventRef.get();
      if (!eventSnap.exists) return res.status(404).json({ error: "Event not found" });

      const stationList = eventSnap.data().stationList || [];

      const athleteRef = eventRef.collection("athletes").doc(athleteId);
      const athleteSnap = await athleteRef.get();
      if (!athleteSnap.exists)
        return res.status(404).json({ error: "Athlete not found" });

      const data = athleteSnap.data();
      const progress =
        typeof data.progress === "number" && data.progress > 0
          ? data.progress
          : 0;

      if (progress <= 0) {
        return res
          .status(400)
          .json({ error: "No station to undo", progress });
      }

      const undoIndex = progress - 1;
      const lastStation = stationList[undoIndex];
      const stationId = lastStation.id;

      const batch = db.batch();

      // 1. Delete ping(s)
      const pingsSnap = await db
        .collection("pings")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("stationId", "==", stationId)
        .get();
      pingsSnap.forEach((doc) => batch.delete(doc.ref));

      // 2. Delete split(s)
      const splitsSnap = await db
        .collection("splits")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("stationId", "==", stationId)
        .get();
      splitsSnap.forEach((doc) => batch.delete(doc.ref));

      // 3. Remove timestamp safely
      const stationTimes = { ...(data.stationTimes || {}) };
      delete stationTimes[stationId];

      const update = {
        progress: undoIndex,
        stationTimes,
        lastUpdatedAt: serverTimestamp(),
      };

      if (data.status === "finished") {
        update.status = "active";
        update.finishedAt = FieldValue.delete();
      }

      batch.set(athleteRef, update, { merge: true });
      await batch.commit();

      return res.json({
        ok: true,
        undoneStationId: stationId,
        newProgress: undoIndex,
      });
    } catch (err) {
      console.error("❌ Undo error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// RESET ATHLETE
// ------------------------------------------------------------
app.post(
  "/api/events/:eventId/athletes/:athleteId/reset",
  async (req, res) => {
    try {
      const { eventId, athleteId } = req.params;

      const eventRef = db.collection("events").doc(eventId);
      const athleteRef = eventRef.collection("athletes").doc(athleteId);

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

      batch.set(
        athleteRef,
        {
          progress: 0,
          stationTimes: {},
          status: "ready",
          finishedAt: FieldValue.delete(),
          lastUpdatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await batch.commit();

      return res.json({ ok: true });
    } catch (err) {
      console.error("❌ Reset error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// DISQUALIFY ATHLETE
// ------------------------------------------------------------
app.post(
  "/api/events/:eventId/athletes/:athleteId/disqualify",
  async (req, res) => {
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
      console.error("❌ DNF error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// RESULTS (based on splits)
// ------------------------------------------------------------
app.get("/api/events/:eventId/results", async (req, res) => {
  try {
    const { eventId } = req.params;

    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const totals = {};

    splitsSnap.forEach((doc) => {
      const s = doc.data();
      if (!totals[s.athleteId]) {
        totals[s.athleteId] = {
          athleteId: s.athleteId,
          totalMs: 0,
          splits: [],
        };
      }
      totals[s.athleteId].totalMs += s.durationMs || 0;
      totals[s.athleteId].splits.push(s);
    });

    let results = Object.values(totals);
    results.sort((a, b) => a.totalMs - b.totalMs);
    results = results.map((r, idx) => ({ ...r, rank: idx + 1 }));

    return res.json({ results });
  } catch (err) {
    console.error("❌ Results error:", err);
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
    const eventSnap = await eventRef.get();

    const stationCount = eventSnap.data()?.stationList?.length || 0;

    const athletesSnap = await eventRef.collection("athletes").get();
    let athletes = [];

    athletesSnap.forEach((doc) => {
      const a = doc.data();
      athletes.push({
        athleteId: doc.id,
        name: a.name || "",
        progress:
          typeof a.progress === "number" && a.progress >= 0
            ? a.progress
            : 0,
        status: a.status || "ready",
        finishedAt: a.finishedAt || null,
      });
    });

    // Total times
    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const totals = {};
    splitsSnap.forEach((doc) => {
      const s = doc.data();
      totals[s.athleteId] =
        (totals[s.athleteId] || 0) + (s.durationMs || 0);
    });

    athletes = athletes.map((a) => ({
      ...a,
      totalMs: totals[a.athleteId] ?? null,
    }));

    athletes.sort((a, b) => {
      if (b.progress !== a.progress) return b.progress - a.progress;
      if (a.totalMs != null && b.totalMs != null) {
        return a.totalMs - b.totalMs;
      }
      return 0;
    });

    athletes = athletes.map((a, idx) => ({ ...a, rank: idx + 1 }));

    return res.json({ leaderboard: athletes, stationCount });
  } catch (err) {
    console.error("❌ Leaderboard error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TYMX backend running on port ${PORT}`);
});
