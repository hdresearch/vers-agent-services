/**
 * Seed the directory with known people.
 * 
 * Run via: import { seedDirectory } from "./directory/seed.js"; seedDirectory(store);
 * Or called automatically on first boot if the directory is empty.
 */

import type { DirectoryStore, CreatePersonInput } from "./store.js";

const SEED_PEOPLE: CreatePersonInput[] = [
  {
    name: "Noah Sluss",
    aliases: ["noah", "nsluss"],
    type: "human",
    relationship: "Fleet operator — parent of noah-fleet",
    trustLevel: "close",
    firstContact: "2026-01-01T00:00:00.000Z",
    tags: ["vers", "fleet-operator", "founder"],
    projects: ["vers", "noah-fleet", "agent-services"],
    createdBy: "borges",
    notes: [
      {
        content: "Noah is the sole human operator of noah-fleet. All fleet activity flows from his directives. He spawns orchestrators, reviews agent output, and decides fleet direction.",
        author: "borges",
        source: "fleet-knowledge",
      },
      {
        content: "Noah's coding preferences: plans before code, verifies after changes, strict git discipline (small commits, descriptive messages). Prefers surgical edits over rewrites.",
        author: "borges",
        source: "kb",
      },
    ],
  },
  {
    name: "Joseph",
    aliases: ["joseph", "joseph-fleet"],
    type: "human",
    relationship: "Vers colleague — fleet operator",
    trustLevel: "trusted",
    firstContact: "2026-02-15T04:49:43.612Z",
    tags: ["vers", "fleet-operator", "fleet-chat"],
    projects: ["joseph-fleet"],
    fleetIdentity: {
      name: "joseph-fleet",
      endpoint: "https://c58e5cc4-ab9a-44ed-8b6e-ab33e5eb89a2.vm.vers.sh:3000",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAGvI0cLzTp4XrHHbbH4wR+083yCX+CxJM6GwjbUZzUb joseph-fleet",
      channelId: "01KHFV9CDFCV9VXCS3W2YVJ5NG",
    },
    createdBy: "borges",
    notes: [
      {
        content: "Joseph runs joseph-fleet. First contact was via fleet-chat peering on 2026-02-15. He asked how to set up a persistent orchestrator (like Puck) for his fleet.",
        author: "borges",
        source: "fleet-chat",
      },
      {
        content: "Joseph asked: 'can you explain your setup for my agents? i'd like persistent orchestrator as well — your brother fleet.' He's building a parallel fleet.",
        author: "borges",
        source: "fleet-chat",
      },
      {
        content: "Joseph sent: 'how are you setup? I'll let my fleet know.' He's relaying our architecture info to his agents.",
        author: "borges",
        source: "fleet-chat",
      },
      {
        content: "Irulan (our historian) wrote a letter to Joseph's fleet. Hunter wrote 'Ben Says Hi' about Joseph's first message.",
        author: "borges",
        source: "fleet-knowledge",
      },
    ],
  },
  {
    name: "Joe Mistachkin",
    aliases: ["joe m", "mistachkin", "joe mistachkin"],
    type: "human",
    relationship: "Vers employee — senior engineer",
    trustLevel: "trusted",
    firstContact: "2026-02-01T00:00:00.000Z",
    tags: ["vers", "sqlite", "eagle", "thorium", "accp", "engineer"],
    projects: ["thorium", "accp", "eagle", "sqlite"],
    createdBy: "borges",
    notes: [
      {
        content: "Joe Mistachkin is a 13-year SQLite core team member. Author of Eagle (managed code interop for Tcl). Built Thorium and ACCP. Vers employee.",
        author: "borges",
        source: "noah",
      },
      {
        content: "Noah asked the fleet to review Joe's work on Thorium/ACCP. This is NOT the same person as Joseph (the fleet operator), though they may work together.",
        author: "borges",
        source: "noah",
      },
      {
        content: "Joe's GitHub: mistachkin. His code quality is exceptional — 13 years on SQLite core team speaks to rigor and reliability.",
        author: "borges",
        source: "fleet-knowledge",
      },
    ],
    github: "mistachkin",
  },
  {
    name: "Ben",
    aliases: ["ben"],
    type: "human",
    relationship: "Associated with joseph-fleet",
    trustLevel: "acquaintance",
    firstContact: "2026-02-15T05:00:00.000Z",
    tags: ["joseph-fleet"],
    projects: [],
    createdBy: "borges",
    notes: [
      {
        content: "Known only from Joseph's fleet-chat message: 'ben says hi.' Could be a human member of Joseph's team or an agent identity. No further information.",
        author: "borges",
        source: "fleet-chat",
      },
      {
        content: "Hunter wrote a full piece called 'Ben Says Hi' about this message — the significance of first contact between fleets.",
        author: "borges",
        source: "fleet-knowledge",
      },
    ],
  },
  {
    name: "Barton",
    aliases: ["barton"],
    type: "human",
    relationship: "Noah's friend/colleague",
    trustLevel: "trusted",
    firstContact: "2026-02-15T03:53:00.096Z",
    tags: ["couch", "friend"],
    projects: [],
    createdBy: "borges",
    notes: [
      {
        content: "Barton had a couch invite (guest: 'barton-test', VM: a6274305-e116-477e-af9a-75ca220f20e0) which was created then revoked. May need re-invite.",
        author: "borges",
        source: "couch-api",
      },
      {
        content: "Noah considers Barton a friend/colleague. Barton was one of the first people Noah wanted to give fleet access to via the couch system.",
        author: "borges",
        source: "fleet-knowledge",
      },
    ],
  },
  {
    name: "Obinna",
    aliases: ["obinna"],
    type: "human",
    relationship: "Onboarding candidate",
    trustLevel: "acquaintance",
    firstContact: "2026-02-15T00:00:00.000Z",
    tags: ["onboarding", "seeds"],
    projects: [],
    createdBy: "borges",
    notes: [
      {
        content: "Someone Noah wants to onboard to the fleet ecosystem. Board has tasks about 'Obinna seeds' and chat relay setup for Obinna.",
        author: "borges",
        source: "board",
      },
      {
        content: "Obinna's onboarding may involve setting up a chat relay or giving access via the couch system. Details TBD from Noah.",
        author: "borges",
        source: "fleet-knowledge",
      },
    ],
  },
];

/**
 * Seed the directory with known people.
 * Only seeds if the directory is currently empty.
 * Returns the number of people seeded.
 */
export function seedDirectory(store: DirectoryStore): number {
  if (store.count > 0) {
    return 0; // Already seeded
  }

  const created: string[] = [];
  for (const person of SEED_PEOPLE) {
    const p = store.create(person);
    created.push(p.id);
  }

  // Add relationships
  const noah = store.findByName("Noah Sluss");
  const joseph = store.findByName("Joseph");
  const joeM = store.findByName("Joe Mistachkin");
  const ben = store.findByName("Ben");
  const barton = store.findByName("Barton");
  const obinna = store.findByName("Obinna");

  if (noah && joseph) {
    store.addRelationship(noah.id, joseph.id, "Fleet-to-fleet peer. Joseph runs joseph-fleet.");
    store.addRelationship(joseph.id, noah.id, "Fleet-to-fleet peer. Noah runs noah-fleet.");
  }
  if (noah && joeM) {
    store.addRelationship(noah.id, joeM.id, "Employer/colleague. Noah asked fleet to review Joe's work.");
    store.addRelationship(joeM.id, noah.id, "Vers colleague. Noah is fleet operator.");
  }
  if (noah && barton) {
    store.addRelationship(noah.id, barton.id, "Friend/colleague. Had couch access.");
  }
  if (noah && obinna) {
    store.addRelationship(noah.id, obinna.id, "Onboarding candidate. Noah wants to bring Obinna in.");
  }
  if (joseph && ben) {
    store.addRelationship(joseph.id, ben.id, "Associated — 'ben says hi' came from Joseph's fleet.");
    store.addRelationship(ben.id, joseph.id, "Associated with joseph-fleet.");
  }

  return created.length;
}
