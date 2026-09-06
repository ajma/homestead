import { buildApp } from "./app.js";

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 7420), host: "0.0.0.0" });
