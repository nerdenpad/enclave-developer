import { createFileRoute } from "@tanstack/react-router";
import { EnclavePage, headForPath } from "@/enclave/EnclavePage";

export const Route = createFileRoute("/")({
  head: () => headForPath("/"),
  component: Index,
});

function Index() {
  return <EnclavePage pathname="/" />;
}
