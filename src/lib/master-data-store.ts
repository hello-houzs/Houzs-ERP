"use client";

// Master data store — reactive localStorage lists for dropdown options.
// Organizers, Venues, PICs, Contractors. (Brand / State / EventType are
// baked into the type system as enums, so they're not stored here.)
//
// Seeded on first read from mockEvents so the app starts with real values.

import { useEffect, useState } from "react";
import { mockEvents, type MalaysianState } from "./mock-data";

const K_ORG = "houzs-master-organizers-v1";
const K_VEN = "houzs-master-venues-v1";
const K_PIC = "houzs-master-pics-v1";
const K_CON = "houzs-master-contractors-v1";
const K_DRV = "houzs-master-drivers-v1";
const K_LORI = "houzs-master-lori-v1";

export interface VenueRecord {
  name: string;
  state: MalaysianState;
}

export interface DriverRecord {
  name: string;
  phone: string;
}

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ---------- seeds ----------
function seedOrganizers(): string[] {
  return Array.from(new Set(mockEvents.map((e) => e.organizer))).sort();
}
function seedVenues(): VenueRecord[] {
  const map = new Map<string, VenueRecord>();
  for (const e of mockEvents) {
    const key = `${e.venue}|${e.state}`;
    if (!map.has(key)) map.set(key, { name: e.venue, state: e.state });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}
function seedPics(): string[] {
  return Array.from(new Set(mockEvents.map((e) => e.pic).filter(Boolean) as string[])).sort();
}
function seedContractors(): string[] {
  return Array.from(new Set(mockEvents.map((e) => e.contractor))).sort();
}
function seedDrivers(): DriverRecord[] {
  return [
    { name: "YUNUS",   phone: "013-580 0830" },
    { name: "RAHMAN",  phone: "012-345 6789" },
    { name: "LIM",     phone: "016-777 1234" },
  ];
}
function seedLori(): string[] {
  return ["VPC9058", "VCS1234", "WXY5678"];
}

// ---------- readers (with SSR guards + first-read seeding) ----------
function readList(key: string, seeder: () => string[]): string[] {
  if (typeof window === "undefined") return seeder();
  const raw = localStorage.getItem(key);
  if (raw === null) {
    const seeded = seeder();
    localStorage.setItem(key, JSON.stringify(seeded));
    return seeded;
  }
  return safeParse<string[]>(raw, seeder());
}
function readVenues(): VenueRecord[] {
  if (typeof window === "undefined") return seedVenues();
  const raw = localStorage.getItem(K_VEN);
  if (raw === null) {
    const seeded = seedVenues();
    localStorage.setItem(K_VEN, JSON.stringify(seeded));
    return seeded;
  }
  return safeParse<VenueRecord[]>(raw, seedVenues());
}
function readDrivers(): DriverRecord[] {
  if (typeof window === "undefined") return seedDrivers();
  const raw = localStorage.getItem(K_DRV);
  if (raw === null) {
    const seeded = seedDrivers();
    localStorage.setItem(K_DRV, JSON.stringify(seeded));
    return seeded;
  }
  return safeParse<DriverRecord[]>(raw, seedDrivers());
}

function writeList(key: string, arr: string[]) {
  localStorage.setItem(key, JSON.stringify(arr));
  emit();
}
function writeVenues(arr: VenueRecord[]) {
  localStorage.setItem(K_VEN, JSON.stringify(arr));
  emit();
}
function writeDrivers(arr: DriverRecord[]) {
  localStorage.setItem(K_DRV, JSON.stringify(arr));
  emit();
}

// ---------- hook ----------
export interface MasterData {
  organizers: string[];
  venues: VenueRecord[];
  pics: string[];
  contractors: string[];
  drivers: DriverRecord[];
  lori: string[];
}

function readAll(): MasterData {
  return {
    organizers: readList(K_ORG, seedOrganizers),
    venues: readVenues(),
    pics: readList(K_PIC, seedPics),
    contractors: readList(K_CON, seedContractors),
    drivers: readDrivers(),
    lori: readList(K_LORI, seedLori),
  };
}

export function useMasterData(): MasterData {
  const [data, setData] = useState<MasterData>(() => ({
    organizers: [],
    venues: [],
    pics: [],
    contractors: [],
    drivers: [],
    lori: [],
  }));
  useEffect(() => {
    setData(readAll());
    const onChange = () => setData(readAll());
    listeners.add(onChange);
    window.addEventListener("storage", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return data;
}

// ---------- mutations ----------
function addUnique(key: string, seeder: () => string[], value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  const arr = readList(key, seeder);
  if (arr.includes(trimmed)) return;
  arr.push(trimmed);
  arr.sort();
  writeList(key, arr);
}
function removeFromList(key: string, seeder: () => string[], value: string) {
  const arr = readList(key, seeder).filter((v) => v !== value);
  writeList(key, arr);
}

export function addOrganizer(name: string)   { addUnique(K_ORG, seedOrganizers, name); }
export function removeOrganizer(name: string) { removeFromList(K_ORG, seedOrganizers, name); }

export function addPic(name: string)   { addUnique(K_PIC, seedPics, name); }
export function removePic(name: string) { removeFromList(K_PIC, seedPics, name); }

export function addContractor(name: string)   { addUnique(K_CON, seedContractors, name); }
export function removeContractor(name: string) { removeFromList(K_CON, seedContractors, name); }

export function addVenue(name: string, state: MalaysianState) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const arr = readVenues();
  if (arr.some((v) => v.name === trimmed && v.state === state)) return;
  arr.push({ name: trimmed, state });
  arr.sort((a, b) => a.name.localeCompare(b.name));
  writeVenues(arr);
}
export function removeVenue(name: string, state: MalaysianState) {
  const arr = readVenues().filter((v) => !(v.name === name && v.state === state));
  writeVenues(arr);
}

export function addDriver(name: string, phone: string) {
  const n = name.trim();
  if (!n) return;
  const arr = readDrivers();
  if (arr.some((d) => d.name === n)) return;
  arr.push({ name: n, phone: phone.trim() });
  arr.sort((a, b) => a.name.localeCompare(b.name));
  writeDrivers(arr);
}
export function removeDriver(name: string) {
  const arr = readDrivers().filter((d) => d.name !== name);
  writeDrivers(arr);
}

export function addLori(plate: string)    { addUnique(K_LORI, seedLori, plate); }
export function removeLori(plate: string) { removeFromList(K_LORI, seedLori, plate); }

export function resetMasterData() {
  localStorage.removeItem(K_ORG);
  localStorage.removeItem(K_VEN);
  localStorage.removeItem(K_PIC);
  localStorage.removeItem(K_CON);
  localStorage.removeItem(K_DRV);
  localStorage.removeItem(K_LORI);
  emit();
}
