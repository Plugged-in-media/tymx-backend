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

// Health Check
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "TYMX backend running (Render)" });
});

// Helper timestamp
const serverTimestamp = () => admin.firestore.Timestamp.now();

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

// ------------------------------
// CHECKPOINT PING
// ------------------------------
app.post("/api/checkpoint-ping", async (req, res) => {
  try {
    const { eventId, athleteId, checkpointIndex } = req.body;

    if (!eventId || !athleteId || checkpointIndex === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const now = serverTimestamp();

    // Write ping
    const pingRef = await db.collection("pings").add({
      eventId,
      athleteId,
      checkpointIndex,
      timestamp: now,
    });

    // Fetch previous ping
    const prevPingSnap = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("checkpointIndex", "<", checkpointIndex)
      .orderBy("checkpointIndex", "desc")
      .limit(1)
      .get();

    // Calculate split
    if (!prevPingSnap.empty) {
      const prev = prevPingSnap.docs[0].data();
      const durationMs = now.toMillis() - prev.timestamp.toMillis();

      await db.collection("splits").add({
        eventId,
        athleteId,
        segmentIndex: checkpointIndex,
        startTimestamp: prev.timestamp,
        endTimestamp: now,
        durationMs,
      });
    }

    res.json({ ok: true, pingId: pingRef.id });
  } catch (err) {
    console.error("❌ Error handling ping:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// GET EVENT RESULTS
// ------------------------------
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

    const finalResults = Object.values(resultsMap).sort(
      (a, b) => a.totalMs - b.totalMs
    );

    res.json({ results: finalResults });
  } catch (err) {
    console.error("❌ Error getting results:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TYMX backend running on port ${PORT} (Render)`);
});
