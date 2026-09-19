import "dotenv/config";
import express from "express";
import { getDb } from "./db.js";

getDb(); // open the database and apply schema.sql at startup, not on the first request

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`ramp402 gateway listening on :${port}`));
