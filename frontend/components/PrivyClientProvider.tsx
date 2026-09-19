"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export default function PrivyClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const rawAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appId =
    rawAppId && rawAppId.length === 25
      ? rawAppId
      : "cl00000000000000000000000";

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        appearance: {
          theme: "light",
          accentColor: "#171717",
          logo: undefined,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
