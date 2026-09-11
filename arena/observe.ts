// Package C: observation builder + game-legal intent translation.
import type { Observe, ToIntents } from "./types";

export const observe: Observe = () => {
  throw new Error("observe: not implemented");
};

export const toIntents: ToIntents = () => {
  throw new Error("toIntents: not implemented");
};
