import { createFileRoute } from "@tanstack/react-router";
import { EnclavePage, headForPath } from "@/enclave/EnclavePage";

export const Route = createFileRoute("/$")({
  head: ({ params }) => headForPath("/" + ((params as { _splat?: string })._splat ?? "")),
  component: SplatPage,
});

function SplatPage() {
  const params = Route.useParams() as { _splat?: string };
  return <EnclavePage pathname={"/" + (params._splat ?? "")} />;
}
