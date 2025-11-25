import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fs from "fs";

// --- Firebase Admin init ---
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebaseServiceAccount.json", "utf8"),
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// --- Express app ---
const app = express();

// CORS options (allow Expo Go on iPhone, etc.)
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
// Optional but recommended: handle preflight explicitly
app.options("*", cors(corsOptions));

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "TYMX backend running" });
});

// Helper: server timestamp
const serverTimestamp = () => admin.firestore.Timestamp.now();

// --- Create event ---
app.post("/api/events", async (req, res) => {
  try {
    const { name, gymId, createdBy, totalCheckpoints, stationList } = req.body;

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
      totalCheckpoints:
        totalCheckpoints || (stationList ? stationList.length : 0),
      stationList: stationList || [],
      createdAt: serverTimestamp(),
    });

    res.json({ eventId: docRef.id });
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Start event ---
app.post("/api/events/:eventId/start", async (req, res) => {
  try {
    const { eventId } = req.params;
    await db.collection("events").doc(eventId).update({
      status: "active",
      startsAt: serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error starting event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Stop event ---
app.post("/api/events/:eventId/stop", async (req, res) => {
  try {
    const { eventId } = req.params;
    await db.collection("events").doc(eventId).update({
      status: "completed",
      endsAt: serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error stopping event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Checkpoint ping ---
app.post("/api/checkpoint-ping", async (req, res) => {
  try {
    const { eventId, athleteId, checkpointIndex } = req.body;

    if (!eventId || !athleteId || checkpointIndex === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const now = serverTimestamp();

    // Create ping
    const pingRef = await db.collection("pings").add({
      eventId,
      athleteId,
      checkpointIndex,
      timestamp: now,
    });

    // Fetch previous ping to calculate split
    const prevPingSnap = await db
      .collection("pings")
      .where("eventId", "==", eventId)
      .where("athleteId", "==", athleteId)
      .where("checkpointIndex", "<", checkpointIndex)
      .orderBy("checkpointIndex", "desc")
      .limit(1)
      .get();

    if (!prevPingSnap.empty) {
      const prevDoc = prevPingSnap.docs[0];
      const prevData = prevDoc.data();

      const durationMs = now.toMillis() - prevData.timestamp.toMillis();

      await db.collection("splits").add({
        eventId,
        athleteId,
        segmentIndex: checkpointIndex,
        startTimestamp: prevData.timestamp,
        endTimestamp: now,
        durationMs,
      });
    }

    res.json({ ok: true, pingId: pingRef.id });
  } catch (err) {
    console.error("Error handling checkpoint ping:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Get event results ---
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

    const results = Object.values(resultsMap).sort(
      (a, b) => a.totalMs - b.totalMs,
    );

    res.json({ results });
  } catch (err) {
    console.error("Error getting results:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TYMX backend running on port ${PORT}`);
});
