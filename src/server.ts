import { createApp } from "./app.js";
import { env } from "./env.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`Barber API listening on http://localhost:${env.port}`);
  console.log(`SMS provider: ${env.smsProvider}${env.smsProvider === "console" ? " (OTP codes print here)" : ""}`);
});
