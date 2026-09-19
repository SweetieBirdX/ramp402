"use client";

import { useEffect, useState, useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet } from "@privy-io/react-auth/extended-chains";

let globalAccessTokenGetter: (() => Promise<string | null>) | null = null;

export function setGlobalAccessTokenGetter(getter: (() => Promise<string | null>) | null): void {
  globalAccessTokenGetter = getter;
}

export async function getAccessToken(): Promise<string | null> {
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
}

export function useAuth(): AuthState {
  const { ready, authenticated, user, getAccessToken: privyGetAccessToken, login, logout } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);
  const [isCreatingWallet, setIsCreatingWallet] = useState(false);

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

  return {
    ready,
    authenticated,
    stellarAddress,
    getAccessToken: privyGetAccessToken,
    user,
    email,
    login,
    logout,
    isCreatingWallet,
  };
}
