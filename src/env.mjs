// Shared env helpers for dual-rail (no side effects).

export function envList(name, fallback = '') {
  return (process.env[name] || fallback).split(',').map((s) => s.trim()).filter(Boolean)
}

export function envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) ? n : fallback
}
