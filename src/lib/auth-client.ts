"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client. No baseURL: same-origin requests to
 * /api/auth/* are what we want in every environment, and hardcoding an origin
 * is how a staging build ends up posting credentials at production.
 */
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
