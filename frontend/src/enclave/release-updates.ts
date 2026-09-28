// Public status history is editorial and sourced from repository commits. Add entries only for shipped changes.
export const releaseUpdates = [
  { date: "2026-09-28", title: "Roadmap refreshed", detail: "Published the current release plan and acceptance criteria.", revision: "b2f090d" },
  { date: "2026-09-26", title: "Arc deployment configuration", detail: "Added Arc Mainnet settlement deployment while keeping public checkout disabled.", revision: "471b90f" },
  { date: "2026-09-25", title: "Development walkthrough", detail: "Added a local simulation walkthrough for technical review.", revision: "2a213ef" },
] as const;
