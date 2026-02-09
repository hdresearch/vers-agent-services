import { Hono } from "hono";

// Stub — to be implemented
export const boardRoutes = new Hono();

boardRoutes.get("/", (c) => c.json({ service: "board", status: "stub" }));
