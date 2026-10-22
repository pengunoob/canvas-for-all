"use client";

import type { FormEvent, PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, ID, Query } from "appwrite";
import { account, appwriteReady, boardsCollectionId, databaseId, databaseReady, pixelsCollectionId, realtime, tablesDB } from "@/lib/appwrite";

const SIZE = 100;
const PIXEL_BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 550;
const BATCH_DEBOUNCE_MS = 75;
const SERVER_SYNC_INTERVAL_MS = 2_000;
const COLORS = ["#171A1F", "#6D7880", "#FFFFFF", "#EF6B6B", "#F3A64A", "#F6D95D", "#A9D273", "#55B991", "#3AB7C5", "#5689E8", "#7968D8", "#C97AC8", "#E989AF", "#B57952", "#F2EFE8"];
type User = { $id: string; name: string };
type Board = { $id: string; title: string; code: string; memberIds?: string[] };
type Pixel = { boardId: string; cell: number; color: string };
type PendingPixel = {
  boardId: string;
  cell: number;
  color: string;
  updatedBy: string;
  updatedAt: string;
};

function problem(error: unknown) { return typeof error === "object" && error && "message" in error ? String(error.message) : "Something went wrong. Try again."; }
function code() { return Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join(""); }

export default function Home() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastCell = useRef<number | null>(null);
  const unsubscribe = useRef<(() => Promise<void>) | null>(null);
  const pixelQueue = useRef(new Map<string, PendingPixel>());
  const isFlushing = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitAt = useRef(0);
  const syncTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isSyncing = useRef(false);
  const lastServerSync = useRef<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [pixels, setPixels] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState(COLORS[3]);
  const [modal, setModal] = useState<"auth" | "create" | "join" | "setup" | null>(null);
  const [login, setLogin] = useState(false);
  const [name, setName] = useState("Quinn’s canvas experiment");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingPixels, setPendingPixels] = useState(0);

  useEffect(() => { if (appwriteReady) account.get().then((u) => setUser({ $id: u.$id, name: u.name })).catch(() => undefined); }, []);
  useEffect(() => () => {
    void unsubscribe.current?.();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    if (syncTimer.current) clearInterval(syncTimer.current);
  }, []);

  const paintBoard = useCallback(() => {
    const element = canvas.current; const context = element?.getContext("2d");
    if (!element || !context) return;
    const step = element.width / SIZE;
    context.fillStyle = "#fffefa"; context.fillRect(0, 0, element.width, element.height);
    Object.entries(pixels).forEach(([cell, color]) => { const index = Number(cell); context.fillStyle = color; context.fillRect((index % SIZE) * step, Math.floor(index / SIZE) * step, step, step); });
    context.strokeStyle = "rgba(58,64,68,.11)"; context.lineWidth = 1;
    for (let index = 0; index <= SIZE; index += 1) { const pos = index * step + .5; context.beginPath(); context.moveTo(pos, 0); context.lineTo(pos, element.height); context.stroke(); context.beginPath(); context.moveTo(0, pos); context.lineTo(element.width, pos); context.stroke(); }
  }, [pixels]);
  useEffect(() => { paintBoard(); }, [paintBoard]);

  const loadPixels = async (boardId: string, since?: string | null, preserveLivePixels = false) => {
    const all: Record<number, string> = {}; let offset = 0;
    const syncStartedAt = new Date().toISOString();
    while (true) {
      const queries = [Query.equal("boardId", boardId)];
      if (since) queries.push(Query.greaterThanEqual("$updatedAt", since));
      queries.push(Query.limit(100), Query.offset(offset));
      const result = await tablesDB.listRows(databaseId, pixelsCollectionId, queries);
      result.rows.forEach((row) => { const pixel = row as unknown as Pixel; all[pixel.cell] = pixel.color; });
      offset += result.rows.length; if (offset >= result.total || !result.rows.length) break;
    }
    // Preserve events received during the initial load; later server polls win.
    setPixels((current) => preserveLivePixels ? ({ ...all, ...current }) : ({ ...current, ...all }));
    lastServerSync.current = syncStartedAt;
  };

  const enter = async (next: Board) => {
    if (!databaseReady) { setModal("setup"); return; }
    try {
      await unsubscribe.current?.();
      unsubscribe.current = null;
      setPixels({});
      setBoard(next);
      const subscription = await realtime.subscribe<Pixel>(
        Channel.tablesdb(databaseId).table(pixelsCollectionId).row(),
        (update) => {
        const pixel = update.payload as Pixel;
        if (update.events.some((event) => event.includes(".create") || event.includes(".update") || event.includes(".upsert"))) setPixels((old) => ({ ...old, [pixel.cell]: pixel.color }));
        },
        [Query.equal("boardId", next.$id)],
      );
      unsubscribe.current = subscription.unsubscribe;
      await loadPixels(next.$id, null, true);
      syncTimer.current = setInterval(() => {
        if (isSyncing.current) return;
        isSyncing.current = true;
        void loadPixels(next.$id, lastServerSync.current).catch((error) => {
          setMessage(`Couldn’t refresh the canvas: ${problem(error)}`);
        }).finally(() => { isSyncing.current = false; });
      }, SERVER_SYNC_INTERVAL_MS);
    } catch (error) { setBoard(null); setMessage(problem(error)); }
  };

  function schedulePixelFlush() {
    if (isFlushing.current || retryTimer.current || flushTimer.current || !pixelQueue.current.size) return;
    const remainingCooldown = Math.max(0, lastCommitAt.current + BATCH_INTERVAL_MS - Date.now());
    const delay = Math.max(BATCH_DEBOUNCE_MS, remainingCooldown);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flushPixelQueue();
    }, delay);
  }

  const flushPixelQueue = useCallback(async () => {
    if (isFlushing.current || retryTimer.current || !pixelQueue.current.size) return;
    isFlushing.current = true;
    const batch = Array.from(pixelQueue.current.entries()).slice(0, PIXEL_BATCH_SIZE) as [string, PendingPixel][];
    batch.forEach(([documentId]) => pixelQueue.current.delete(documentId));
    setPendingPixels(pixelQueue.current.size + batch.length);
    let transactionId: string | null = null;

    try {
      const transaction = await tablesDB.createTransaction({ ttl: 60 });
      transactionId = transaction.$id;
      await tablesDB.createOperations({
        transactionId,
        operations: batch.map(([rowId, data]) => ({ action: "upsert", databaseId, tableId: pixelsCollectionId, rowId, data })),
      });
      await tablesDB.updateTransaction({ transactionId, commit: true });
      lastCommitAt.current = Date.now();
      setPendingPixels(pixelQueue.current.size);
    } catch (error) {
      batch.forEach(([documentId, data]) => pixelQueue.current.set(documentId, data));
      setPendingPixels(pixelQueue.current.size);
      if (transactionId) await tablesDB.updateTransaction({ transactionId, rollback: true }).catch(() => undefined);
      const status = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
      setMessage(status === 429 ? "Saving paused briefly to respect Appwrite’s rate limit. Your queued marks will retry automatically." : `A pixel could not save yet: ${problem(error)}`);
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        schedulePixelFlush();
      }, status === 429 ? 5_000 : 2_000);
    } finally {
      isFlushing.current = false;
      if (!retryTimer.current) schedulePixelFlush();
    }
  }, []);

  const queuePixel = useCallback((documentId: string, data: PendingPixel) => {
    pixelQueue.current.set(documentId, data);
    setPendingPixels(pixelQueue.current.size);
    schedulePixelFlush();
  }, []);

  const requireUser = (next: "create" | "join") => { if (!user) { setLogin(false); setModal("auth"); setMessage("Create an account to make a mark."); } else setModal(next); };
  const authenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!appwriteReady) { setMessage("Add the Appwrite project settings to .env.local first."); return; }
    const data = new FormData(event.currentTarget); const displayName = String(data.get("displayName") || "").trim(); const email = String(data.get("email") || ""); const password = String(data.get("password") || "");
    setBusy(true); setMessage("");
    try {
      if (!login) { if (!displayName) throw new Error("Please enter a display name."); await account.create({ userId: ID.unique(), email, password, name: displayName }); }
      await account.createEmailPasswordSession({ email, password });
      if (login && displayName) await account.updateName({ name: displayName });
      const current = await account.get(); setUser({ $id: current.$id, name: current.name }); setModal(null);
    } catch (error) { setMessage(problem(error)); } finally { setBusy(false); }
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!user || !databaseReady) { setModal("setup"); return; } setBusy(true);
    try {
      const created = await tablesDB.createRow(databaseId, boardsCollectionId, ID.unique(), { title: name.trim() || "Untitled canvas", code: code(), ownerID: user.$id, memberIds: [user.$id], createdAt: new Date().toISOString() }) as unknown as Board;
      setModal(null); await enter(created);
    } catch (error) { setMessage(problem(error)); } finally { setBusy(false); }
  };
  const join = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!user || !databaseReady) { setModal("setup"); return; } setBusy(true);
    try {
      const found = await tablesDB.listRows(databaseId, boardsCollectionId, [Query.equal("code", joinCode.trim().toUpperCase()), Query.limit(1)]);
      if (!found.rows.length) throw new Error("No canvas has that room code.");
      const next = found.rows[0] as unknown as Board; const people = next.memberIds ?? [];
      if (!people.includes(user.$id)) { if (people.length >= 50) throw new Error("This room already has 50 artists."); next.memberIds = [...people, user.$id]; await tablesDB.updateRow(databaseId, boardsCollectionId, next.$id, { memberIds: next.memberIds }); }
      setModal(null); await enter(next);
    } catch (error) { setMessage(problem(error)); } finally { setBusy(false); }
  };
  const paint = async (event: PointerEvent<HTMLCanvasElement>) => {
    if (!board || !user || (event.type === "pointermove" && event.buttons === 0)) return;
    const bounds = event.currentTarget.getBoundingClientRect(); const col = Math.floor((event.clientX - bounds.left) / bounds.width * SIZE); const row = Math.floor((event.clientY - bounds.top) / bounds.height * SIZE);
    if (col < 0 || row < 0 || col >= SIZE || row >= SIZE) return; const cell = row * SIZE + col;
    if (lastCell.current === cell) return; lastCell.current = cell; setPixels((old) => ({ ...old, [cell]: selected }));
    const documentId = `px_${board.$id}_${cell}`;
    queuePixel(documentId, { boardId: board.$id, cell, color: selected, updatedBy: user.$id, updatedAt: new Date().toISOString() });
  };
  const leave = () => {
    void unsubscribe.current?.();
    unsubscribe.current = null;
    if (syncTimer.current) clearInterval(syncTimer.current);
    syncTimer.current = null;
    isSyncing.current = false;
    lastServerSync.current = null;
    setBoard(null);
    setPixels({});
  };
  const signOut = async () => { await account.deleteSession({ sessionId: "current" }).catch(() => undefined); leave(); setUser(null); };

  if (board) return <main className="room"><header><button className="brand" onClick={leave}>✦ Canvas for All</button><div><span className="live">● LIVE</span><button className="avatar" onClick={signOut}>{user?.name?.slice(0, 1).toUpperCase()}</button></div></header><section className="room-title"><div><button className="back" onClick={leave}>← All canvases</button><h1>{board.title}</h1><p>Every little mark is saved and shared in real time.</p></div><button className="room-code" onClick={() => navigator.clipboard.writeText(board.code)}><small>ROOM CODE · COPY</small><b>{board.code}</b></button></section><section className="studio"><div><p className="canvas-label">✦ 100 × 100 shared canvas</p><div className="canvas-shell"><canvas ref={canvas} width="1000" height="1000" aria-label="Interactive shared pixel canvas" onPointerDown={(event) => { lastCell.current = null; event.currentTarget.setPointerCapture(event.pointerId); void paint(event); }} onPointerMove={(event) => void paint(event)} onPointerUp={() => { lastCell.current = null; }} /></div><p className="hint">{pendingPixels ? `Saving ${pendingPixels} queued mark${pendingPixels === 1 ? "" : "s"}…` : "Click or drag to paint. Your marks save instantly."}</p></div><aside><h2>Color studio</h2><p>Pick a color, then paint.</p><div className="palette">{COLORS.map((hex) => <button key={hex} className={hex === selected ? "selected" : ""} style={{ background: hex }} aria-label={hex} onClick={() => setSelected(hex)}>{hex === selected ? "✓" : ""}</button>)}</div><div className="swatch"><i style={{ background: selected }} /><span><small>SELECTED COLOR</small><b>{selected}</b></span></div><div className="artists">◌ <span><b>{board.memberIds?.length ?? 1} / 50 artists</b><small>Invite friends with your code</small></span></div></aside></section>{message && <Toast text={message} close={() => setMessage("")} />}</main>;

  return <main><header><button className="brand">✦ Canvas for All</button>{user ? <div><span className="hello">Hey, {user.name || "artist"}</span><button className="avatar" onClick={signOut}>{user.name?.slice(0, 1).toUpperCase()}</button></div> : <button className="login" onClick={() => { setLogin(true); setModal("auth"); }}>Log in ↗</button>}</header><section className="hero"><div><span className="eyebrow">— A BLANK SPACE FOR THE INTERNET</span><h1>Make a mark.<br /><em>See what happens.</em></h1><p>Invite up to 50 people to turn one small canvas into a living social experiment. Every pixel has a story.</p><div className="actions"><button className="primary" onClick={() => requireUser("create")}>＋ Create a canvas</button><button className="secondary" onClick={() => requireUser("join")}>Join with a code ↗</button></div><div className="facts"><span>◉ 100 × 100 pixels</span><span>◉ 50 artists together</span><span>◉ saved forever</span></div></div><div className="art"><div className="pixel-art">{Array.from({ length: 196 }, (_, index) => <i key={index} className={`p${index}`} />)}</div><label>one pixel at a time</label></div></section><section className="steps"><span>FOR QUINN’S NEXT SOCIAL EXPERIMENT</span><h2>The internet, in miniature.</h2><div><article><b>01</b><h3>Start a room</h3><p>Name your canvas and get a shareable code.</p></article><article><b>02</b><h3>Gather your people</h3><p>Up to 50 artists can enter the same room.</p></article><article><b>03</b><h3>Watch it unfold</h3><p>Every stroke saves live — perfect for documenting change.</p></article></div></section><footer>© Canvas for All <button onClick={() => setModal("setup")}>Appwrite setup</button></footer>
    {modal === "auth" && <Dialog close={() => setModal(null)} title={login ? "Welcome back, artist" : "Claim your paintbrush"} text={login ? "Log in to pick up where you left off." : "Create an account to make your mark on shared canvases."}><form onSubmit={authenticate}>{!login && <Field label="Display name" name="displayName" placeholder="What should we call you?" required />}{login && <Field label="Display name (optional)" name="displayName" placeholder="Update your display name" />}{<Field label="Email" name="email" placeholder="you@example.com" type="email" required />}{<Field label="Password" name="password" placeholder="At least 8 characters" type="password" required />}{<button className="primary wide" disabled={busy}>{busy ? "Working…" : login ? "Log in" : "Create account"}</button>}</form><button className="link" onClick={() => setLogin(!login)}>{login ? "New here? Create an account" : "Already have an account? Log in"}</button></Dialog>}
    {modal === "create" && <Dialog close={() => setModal(null)} title="Start a blank canvas" text="You’ll get a room code to share with up to 49 other artists."><form onSubmit={create}><Field label="Canvas name" value={name} onChange={setName} required /><button className="primary wide" disabled={busy}>{busy ? "Creating…" : "Create canvas"}</button></form></Dialog>}
    {modal === "join" && <Dialog close={() => setModal(null)} title="Join a canvas" text="Ask the host for their six-character room code."><form onSubmit={join}><Field label="Room code" value={joinCode} onChange={(value) => setJoinCode(value.toUpperCase())} placeholder="A1B2C3" required /><button className="primary wide" disabled={busy}>{busy ? "Joining…" : "Enter canvas"}</button></form></Dialog>}
    {modal === "setup" && <Dialog close={() => setModal(null)} title="One small Appwrite step" text="Your project connection is in place. Add a database ID and the boards and pixels collection IDs to .env.local, then restart Bun."><a className="primary wide" href="https://cloud.appwrite.io/console" target="_blank" rel="noreferrer">Open Appwrite ↗</a></Dialog>}
    {message && <Toast text={message} close={() => setMessage("")} />}</main>;
}

function Field({ label, name, value, onChange, ...props }: { label: string; name?: string; value?: string; onChange?: (value: string) => void; placeholder?: string; type?: string; required?: boolean }) { return <label>{label}<input name={name} value={value} onChange={(event) => onChange?.(event.target.value)} {...props} /></label>; }
function Dialog({ close, title, text, children }: { close: () => void; title: string; text: string; children: React.ReactNode }) { return <div className="shade"><section className="dialog"><button className="x" onClick={close}>×</button><i>✦</i><h2>{title}</h2><p>{text}</p>{children}</section></div>; }
function Toast({ text, close }: { text: string; close: () => void }) { return <div className="toast">{text}<button onClick={close}>×</button></div>; }
