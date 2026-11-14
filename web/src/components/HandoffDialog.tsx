import { useState } from "react";
import type { Network, Snapshot } from "@api";
import { Button, Modal, ModalHead } from "./ui.tsx";

export function HandoffDialog({ h, network, busy, onSent, onNotSent, onClose }: {
  h: NonNullable<Snapshot["handoff"]>;
  network: Network;
  busy: boolean;
  onSent: (txHash: string) => void;
  onNotSent: () => void;
  onClose: () => void;
}) {
  const [hash, setHash] = useState("");
  return (
    <Modal onClose={onClose}>
      <ModalHead title={`Step ${h.step}: result unknown`} sub={h.title} onClose={onClose} />
      <div className="px-6 py-5 flex flex-col gap-4 text-[12px]">
        <div className="text-dim">
          A wallet request for <span className="text-text">{h.account}</span> started {new Date(h.since).toLocaleString()} and never reported back.
          Check the wallet or explorer before choosing.
        </div>
        <a className="text-accent hover:underline" target="_blank" rel="noreferrer"
          href={`https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${h.account}`}>
          recent transactions ↗
        </a>
        <div className="flex gap-2">
          <input
            value={hash}
            onChange={(e) => setHash(e.target.value.trim())}
            placeholder="transaction hash"
            className="flex-1 h-8 px-2 bg-bg border border-line-2 rounded-[3px] outline-none focus:border-dim"
          />
          <Button variant="primary" disabled={busy || hash.length < 32} onClick={() => onSent(hash)}>It was sent</Button>
        </div>
        <Button variant="danger" disabled={busy} onClick={onNotSent}>It was not sent: ask again</Button>
      </div>
    </Modal>
  );
}
