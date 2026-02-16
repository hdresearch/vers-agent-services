import { BoardStore } from "./store.js";

// Singleton board store — shared across board routes and review routes
export const boardStore = new BoardStore();
