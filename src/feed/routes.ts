import { Hono } from "hono";

// Stub — to be implemented
export const feedRoutes = new Hono();

feedRoutes.get("/", (c) => c.json({ service: "feed", status: "stub" }));
