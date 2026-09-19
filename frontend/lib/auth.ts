"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet } from "@privy-io/react-auth/extended-chains";

let globalAccessTokenGetter: (() => Promise<string | null>) | null = null;

export function setGlobalAccessTokenGetter(getter: (() => Promise<string | null>) | null): void {
  globalAccessTokenGetter = getter;
}

export async function getAccessToken(): Promise<string | null> {
  if (typeof window !== "undefined") {
    if (
      new URLSearchParams(window.location.search).get("demo") === "true" ||
      window.localStorage.getItem("ramp402_demo_auth") === "true"
    ) {
      return "demo_access_token";
    }
  }
  if (globalAccessTokenGetter) {
    try {
      return await globalAccessTokenGetter();
    } catch {
      return null;
    }
  }
  return null;
}

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  stellarAddress: string | null;
  getAccessToken: () => Promise<string | null>;
  user: ReturnType<typeof usePrivy>["user"];
  email: string | null;
  login: () => void;
  logout: () => Promise<void>;
  isCreatingWallet: boolean;
  isBootstrapping: boolean;
  isBootstrapped: boolean;
  bootstrapError: string | null;
  bootstrap: () => Promise<boolean>;
}

export function useAuth(): AuthState {
  const { ready, authenticated, user, getAccessToken: privyGetAccessToken, login, logout } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);
  const [isCreatingWallet, setIsCreatingWallet] = useState(false);

  const [isDemo] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return (
        params.get("demo") === "true" ||
        window.localStorage.getItem("ramp402_demo_auth") === "true"
      );
    }
    return false;
  });

  useEffect(() => {
    setGlobalAccessTokenGetter(privyGetAccessToken);
  }, [privyGetAccessToken]);

  // Extract user email if present in linkedAccounts or user object
  const email = useMemo(() => {
    if (!user) return null;
    if (user.email?.address) return user.email.address;
    const emailAccount = user.linkedAccounts?.find((acc) => acc.type === "email");
    return emailAccount && "address" in emailAccount ? (emailAccount.address as string) : null;
  }, [user]);

  // Find Stellar wallet in linked accounts
  const existingStellarAddress = useMemo(() => {
    if (!user?.linkedAccounts) return null;
    const stellarWallet = user.linkedAccounts.find(
      (acc) => acc.type === "wallet" && (acc as { chainType?: string }).chainType === "stellar"
    );
    return stellarWallet && "address" in stellarWallet ? (stellarWallet.address as string) : null;
  }, [user]);

  const stellarAddress = existingStellarAddress || createdAddress;

  // Auto-create embedded Stellar wallet on login if none exists
  useEffect(() => {
    let isMounted = true;

    async function ensureStellarWallet() {
      if (ready && authenticated && user && !stellarAddress && !isCreatingWallet) {
        try {
          setIsCreatingWallet(true);
          const result = await createWallet({ chainType: "stellar" });
          if (isMounted && result?.wallet?.address) {
            setCreatedAddress(result.wallet.address);
          }
        } catch (err) {
          console.error("Failed to auto-create embedded Stellar wallet:", err);
        } finally {
          if (isMounted) {
            setIsCreatingWallet(false);
          }
        }
      }
    }

    ensureStellarWallet();

    return () => {
      isMounted = false;
    };
  }, [ready, authenticated, user, stellarAddress, isCreatingWallet, createWallet]);

  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const bootstrap = useCallback(async (): Promise<boolean> => {
    if (!ready || !authenticated || !stellarAddress) return false;
    setIsBootstrapping(true);
    setBootstrapError(null);

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        const { bootstrapSeller } = await import("./api");
        await bootstrapSeller();
        setIsBootstrapped(true);
        return true;
      } catch (err: unknown) {
        // If 409 (embedded wallet not yet indexed by Privy server), wait 1.5s and retry
        const is409 =
          typeof err === "object" &&
          err !== null &&
          "status" in err &&
          (err as { status: unknown }).status === 409;
        if (is409 && attempts < 3) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const msg = err instanceof Error ? err.message : "Bootstrap failed";
        setBootstrapError(msg);
        return false;
      } finally {
        if (attempts >= 3 || isBootstrapped) {
          setIsBootstrapping(false);
        }
      }
    }
    setIsBootstrapping(false);
    return false;
  }, [ready, authenticated, stellarAddress, isBootstrapped]);

  // Auto-call bootstrap once stellarAddress has appeared
  useEffect(() => {
    let active = true;

    if (
      ready &&
      authenticated &&
      stellarAddress &&
      !isCreatingWallet &&
      !isBootstrapped &&
      !isBootstrapping &&
      !bootstrapError
    ) {
      (async () => {
        await Promise.resolve();
        if (!active) return;
        await bootstrap();
      })();
    }

    return () => {
      active = false;
    };
  }, [
    ready,
    authenticated,
    stellarAddress,
    isCreatingWallet,
    isBootstrapped,
    isBootstrapping,
    bootstrapError,
    bootstrap,
  ]);

  const handleLogout = useCallback(async () => {
    setCreatedAddress(null);
    setIsBootstrapped(false);
    setIsBootstrapping(false);
    setBootstrapError(null);
    await logout();
  }, [logout]);

  if (isDemo) {
    return {
      ready: true,
      authenticated: true,
      stellarAddress: "GC2BKJ6UDTJ2HBBGNTVWNXFM6S7V4V5Y6Z7A8B9C0D1E2F3G4H5I6J7K",
      getAccessToken: async () => "demo_access_token",
      user: { id: "did:privy:demo_user_mert" } as unknown as ReturnType<typeof usePrivy>["user"],
      email: "mert@ramp402.org",
      login: () => {},
      logout: handleLogout,
      isCreatingWallet: false,
      isBootstrapping: false,
      isBootstrapped: true,
      bootstrapError: null,
      bootstrap: async () => true,
    };
  }

  return {
    ready,
    authenticated,
    stellarAddress,
    getAccessToken: privyGetAccessToken,
    user,
    email,
    login,
    logout: handleLogout,
    isCreatingWallet,
    isBootstrapping,
    isBootstrapped,
    bootstrapError,
    bootstrap,
  };
}
