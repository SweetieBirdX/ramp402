import { createApp } from "./app.js";
import { getDb } from "./db.js";

getDb(); // open the database and apply schema.sql at startup, not on the first request

const port = Number(process.env.PORT) || 3001;
createApp().listen(port, () => console.log(`ramp402 gateway listening on :${port}`));
