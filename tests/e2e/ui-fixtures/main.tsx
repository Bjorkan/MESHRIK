import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PathModal } from "../../../frontend/src/components/PathModal";
import "../../../frontend/src/index.css";
import "../../../frontend/src/themes.css";
import "../../../frontend/src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.style.fontSize = `${params.get("scale") ?? "100"}%`;

function Fixture() {
  const [open, setOpen] = useState(true);
  const [sent, setSent] = useState("none");
  return (
    <>
      <output aria-label="Send result">{sent}</output>
      <PathModal
        open={open}
        onClose={() => setOpen(false)}
        paths={
          params.has("paths") ? [{ path: "", path_len: 0, received_at: 1 }] : []
        }
        senderInfo={{
          name: "Synthetic sender",
          publicKeyOrPrefix: "",
          lat: null,
          lon: null,
        }}
        contacts={[]}
        config={null}
        messageId={42}
        isOutgoingChan
        isResendable={!params.has("expired")}
        onResend={(id, newTimestamp) =>
          setSent(`${id}:${newTimestamp ? "new" : "repeat"}`)
        }
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
