import * as dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";

const requiredEnvVars = ["DATABASE_URL", "SESSION_SECRET"];
const missing = requiredEnvVars.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
}

const port = Number(process.env.PORT ?? 3000);

createApp()
  .then((app) => {
    app.listen(port, () => {
      console.log(`api listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
