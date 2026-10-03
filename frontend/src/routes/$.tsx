import { createFileRoute, notFound } from "@tanstack/react-router";
import { EnclavePage, headForPath, normalizePath } from "@/enclave/EnclavePage";
import routes from "@/enclave/routes.json";

export const Route = createFileRoute("/$")({
  beforeLoad: ({ location }) => {
    const path = normalizePath(location.pathname);
    if (path === "/404/" || !Object.hasOwn(routes, path)) throw notFound();
  },
  head: ({ params }) => headForPath("/" + ((params as { _splat?: string })._splat ?? "")),
  component: SplatPage,
  notFoundComponent: () => <EnclavePage pathname="/404/" />,
});

function SplatPage() {
  const params = Route.useParams() as { _splat?: string };
  return <EnclavePage pathname={"/" + (params._splat ?? "")} />;
}
