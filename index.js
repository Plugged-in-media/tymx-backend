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
// EXPRESS APP
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
// HEALTH
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

    // Ensure stationList has stable ids
    const normalizedStations = (stationList || []).map((s, idx) => ({
      id: s.id || `station-${idx}`,
      name: s.name || `Station ${idx + 1}`,
      type: s.type || null,
      detail: s.detail || null,
    }));

    const docRef = await db.collection("events").add({
      name,
      gymId: gymId || null,
      createdBy,
      status: "upcoming",
      startsAt: null,
      endsAt: null,
      stationList: normalizedStations,
      totalCheckpoints: normalizedStations.length,
      createdAt: serverTimestamp(),
    });

    res.json({ eventId: docRef.id });
  } catch (err) {
    console.error("❌ Error creating event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// START / STOP EVENT
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
// PING: COMPLETE CURRENT STATION (START / NEXT / END)
// Body: { athleteId, stationId }
// ------------------------------------------------------------
app.post("/api/events/:eventId/ping", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { athleteId, stationId } = req.body;

    if (!athleteId || !stationId) {
      return res.status(400).json({ error: "Missing athleteId or stationId" });
    }

    // Get event
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
    // Map of id -> index
    const stationIndexMap = {};
    stationList.forEach((s, idx) => {
      stationIndexMap[s.id || `station-${idx}`] = idx;
    });

    if (!(stationId in stationIndexMap)) {
      return res.status(400).json({ error: "Unknown stationId" });
    }

    const thisIndex = stationIndexMap[stationId];

    // Get athlete
    const athleteRef = eventRef.collection("athletes").doc(athleteId);
    const athleteSnap = await athleteRef.get();
    if (!athleteSnap.exists) {
      return res.status(404).json({ error: "Athlete not found" });
    }

    const athleteData = athleteSnap.data() || {};
    let progress =
      typeof athleteData.progress === "number" && athleteData.progress >= 0
        ? athleteData.progress
        : 0;
    const stationTimes = athleteData.stationTimes || {};
    const status = athleteData.status || "ready";

    if (status === "dnf") {
      return res
        .status(400)
        .json({ error: "Athlete is DNF and cannot receive pings" });
    }

    // Expected station id given current linear model
    const expectedStation =
      stationList[progress] || stationList[stationList.length - 1];
    const expectedId = expectedStation?.id || `station-${progress}`;

    if (stationId !== expectedId) {
      // For now: enforce linear order.
      // (Out-of-order handling comes later via results editor)
      return res.status(400).json({
        error: "Out-of-order station. Please use admin tools to fix later.",
        expectedStationId: expectedId,
        attemptedStationId: stationId,
      });
    }

    // Prevent duplicate completion of same station
    if (stationTimes[stationId]) {
      return res.status(409).json({
        error: "Station already completed",
        stationId,
      });
    }

    const now = serverTimestamp();

    // Write ping
    await db.collection("pings").add({
      eventId,
      athleteId,
      stationId,
      stationIndex: thisIndex,
      timestamp: now,
    });

    // Compute split relative to previous station completion
    let durationMs = null;

    if (progress > 0) {
      const prevStation = stationList[progress - 1];
      const prevId = prevStation?.id || `station-${progress - 1}`;
      const prevTime = stationTimes[prevId];

      if (prevTime) {
        durationMs = now.toMillis() - prevTime.toMillis();

        await db.collection("splits").add({
          eventId,
          athleteId,
          stationId,
          stationIndex: thisIndex,
          startTimestamp: prevTime,
          endTimestamp: now,
          durationMs,
        });
      }
    }

    const nextProgress = progress + 1;
    const isFinished = nextProgress >= stationList.length;

    const athleteUpdate = {
      progress: nextProgress,
      stationTimes: {
        ...(stationTimes || {}),
        [stationId]: now,
      },
      lastUpdatedAt: now,
    };

    if (isFinished) {
      athleteUpdate.status = "finished";
      athleteUpdate.finishedAt = now;
    } else if (status === "ready") {
      athleteUpdate.status = "active";
    }

    await athleteRef.set(athleteUpdate, { merge: true });

    return res.json({
      ok: true,
      stationId,
      stationIndex: thisIndex,
      progress: nextProgress,
      splitMs: durationMs,
      finished: isFinished,
    });
  } catch (err) {
    console.error("❌ Error in /ping:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// ADMIN: UNDO LAST STATION (UNDO LAST ACTION)
// - Moves progress back by 1
// - Deletes ping + split for last station
// - Removes that station's completion time
// ------------------------------------------------------------
app.post(
  "/api/events/:eventId/athletes/:athleteId/undo",
  async (req, res) => {
    try {
      const { eventId, athleteId } = req.params;

      const eventRef = db.collection("events").doc(eventId);
      const eventSnap = await eventRef.get();
      if (!eventSnap.exists) {
        return res.status(404).json({ error: "Event not found" });
      }
      const stationList = eventSnap.data().stationList || [];

      const athleteRef = eventRef.collection("athletes").doc(athleteId);
      const athleteSnap = await athleteRef.get();
      if (!athleteSnap.exists) {
        return res.status(404).json({ error: "Athlete not found" });
      }

      const data = athleteSnap.data() || {};
      let progress =
        typeof data.progress === "number" && data.progress >= 0
          ? data.progress
          : 0;

      if (progress <= 0) {
        return res.status(400).json({ error: "No station to undo", progress });
      }

      const undoIndex = progress - 1;
      const lastStation = stationList[undoIndex];
      if (!lastStation) {
        return res.status(400).json({ error: "Invalid station to undo" });
      }
      const stationId = lastStation.id || `station-${undoIndex}`;

      const batch = db.batch();

      // Delete ping doc(s) for this station
      const pingsSnap = await db
        .collection("pings")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("stationId", "==", stationId)
        .get();

      pingsSnap.forEach((doc) => batch.delete(doc.ref));

      // Delete split(s) for this station
      const splitsSnap = await db
        .collection("splits")
        .where("eventId", "==", eventId)
        .where("athleteId", "==", athleteId)
        .where("stationId", "==", stationId)
        .get();

      splitsSnap.forEach((doc) => batch.delete(doc.ref));

      // Update athlete: decrement progress, remove stationTimes entry, clear finished flag if needed
      const update = {
        progress: undoIndex,
        [`stationTimes.${stationId}`]: FieldValue.delete(),
        lastUpdatedAt: serverTimestamp(),
      };

      if (data.status === "finished") {
        update.status = "active";
        update.finishedAt = FieldValue.delete();
      }

      batch.set(athleteRef, update, { merge: true });

      await batch.commit();

      return res.json({ ok: true, newProgress: undoIndex, stationId });
    } catch (err) {
      console.error("❌ Error in undo:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// ADMIN: RESET ATHLETE (CLEAR PINGS / SPLITS / TIMES)
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

      // Reset athlete
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
      console.error("❌ Error in reset athlete:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// ADMIN: DISQUALIFY (DNF)
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
      console.error("❌ Error in disqualify:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------------------------------------
// RESULTS (simple totalMs based on splits)
// ------------------------------------------------------------
app.get("/api/events/:eventId/results", async (req, res) => {
  try {
    const { eventId } = req.params;

    const splitsSnap = await db
      .collection("splits")
      .where("eventId", "==", eventId)
      .get();

    const resultsMap = {};

    splitsSnap.forEach((doc) => {
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

    let results = Object.values(resultsMap);
    results.sort((a, b) => a.totalMs - b.totalMs);
    results = results.map((r, idx) => ({ ...r, rank: idx + 1 }));

    res.json({ results });
  } catch (err) {
    console.error("❌ Error in results:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------
// LEADERBOARD (by progress, then totalMs)
// ------------------------------------------------------------
app.get("/api/events/:eventId/leaderboard", async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventRef = db.collection("events").doc(eventId);
    const eventSnap = await eventRef.get();
    const stationList = eventSnap.exists ? eventSnap.data().stationList || [] : [];

    const athletesSnap = await eventRef.collection("athletes").get();
    const athletes = [];

    athletesSnap.forEach((doc) => {
      const data = doc.data();
      athletes.push({
        athleteId: doc.id,
        name: data.name || "",
        progress:
          typeof data.progress === "number" && data.progress >= 0
            ? data.progress
            : 0,
        status: data.status || "ready",
        finishedAt: data.finishedAt || null,
        stationTimes: data.stationTimes || {},
      });
    });

    // TotalMs by splits
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

    let leaderboard = athletes.map((a) => ({
      ...a,
      totalMs: totals[a.athleteId] ?? null,
    }));

    leaderboard.sort((a, b) => {
      if ((b.progress ?? 0) !== (a.progress ?? 0)) {
        return (b.progress ?? 0) - (a.progress ?? 0);
      }
      if (a.totalMs != null && b.totalMs != null) {
        return a.totalMs - b.totalMs;
      }
      return 0;
    });

    leaderboard = leaderboard.map((a, idx) => ({ ...a, rank: idx + 1 }));

    res.json({ leaderboard, stationCount: stationList.length });
  } catch (err) {
    console.error("❌ Error in leaderboard:", err);
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
