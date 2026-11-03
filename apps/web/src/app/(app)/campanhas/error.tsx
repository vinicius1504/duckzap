"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function CampaignsRouteError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Campanhas" error={error} retry={retry} />;
}
