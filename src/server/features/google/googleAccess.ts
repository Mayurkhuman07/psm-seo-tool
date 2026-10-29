import { isEveryAppAuthMode } from "@/lib/auth-mode";
import { getGatewayGoogleStatus } from "@/server/features/google/gatewayGoogle";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

/**
 * Who holds the Google OAuth client that Search Console and Analytics use.
 *
 * - `own_client`: PSM SEO's own (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET),
 *   on app.openseo.so and every self-host mode.
 * - `gateway`: the Every App gateway (AUTH_MODE=everyapp). The gateway
 *   holds the Google client and each member's connection (gatewayGoogle.ts);
 *   PSM SEO keeps no Google client, secret or token, its own connect flow
 *   and callbacks are off, and every Google call goes through the gateway.
 */
type GoogleAccessMode = "own_client" | "gateway";

export async function getGoogleAccessMode(): Promise<GoogleAccessMode> {
  return isEveryAppAuthMode(await getOptionalEnvValue("AUTH_MODE"))
    ? "gateway"
    : "own_client";
}

/**
 * Whether the gateway offers Google to this app: PSM SEO lists
 * `google-workspace` and the gateway holds a Google client. Whether this
 * member has connected is `getGatewayGoogleStatus().connected`.
 */
export async function isGatewayGoogleAvailable(): Promise<boolean> {
  return (await getGatewayGoogleStatus()).available;
}

/** PSM SEO's own OAuth callback routes: absent where the gateway holds Google. */
export async function ownGoogleCallbackDisabled(): Promise<boolean> {
  return (await getGoogleAccessMode()) === "gateway";
}
