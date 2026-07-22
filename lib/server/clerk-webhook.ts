import "server-only";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { getPool } from "../../db/index";
import { getServerConfig } from "./config";
import { ApiError, notFound } from "./errors";

function limited(value: string | null | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export async function handleClerkWebhook(
  request: NextRequest,
  correlationId: string,
) {
  const config = getServerConfig();
  if (config.mode === "demo") {
    throw notFound("Webhook delivery is disabled in demo mode.");
  }

  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request, {
      signingSecret: config.clerkWebhookSigningSecret,
    });
  } catch {
    throw new ApiError({
      status: 400,
      code: "invalid_webhook_signature",
      title: "Invalid webhook",
      detail: "The Clerk webhook signature could not be verified.",
    });
  }

  if (event.type !== "user.created" && event.type !== "user.updated" && event.type !== "user.deleted") {
    return { accepted: true, ignored: true, eventType: event.type };
  }

  const client = await getPool().connect();
  let ignored = false;
  try {
    await client.query("begin");
    if (event.type === "user.deleted") {
      const clerkUserId = event.data.id;
      if (clerkUserId) {
        const deleted = await client.query(
          `insert into users (clerk_user_id, deleted_at)
           values ($1, now())
           on conflict (clerk_user_id) do update
             set email = null,
                 display_name = null,
                 avatar_url = null,
                 deleted_at = now(),
                 updated_at = now()
           where users.deleted_at is null
              or users.email is not null
              or users.display_name is not null
              or users.avatar_url is not null
           returning id`,
          [clerkUserId],
        );
        if (deleted.rows[0]) {
          await client.query(
            `insert into audit_events
               (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
             values (null, 'clerk.user_deleted', 'user', $1, $2::uuid, $3::jsonb)`,
            [
              deleted.rows[0].id,
              correlationId,
              JSON.stringify({ deleted: true }),
            ],
          );
        } else {
          ignored = true;
        }
      } else {
        ignored = true;
      }
    } else {
      const user = event.data;
      const primaryEmail = user.email_addresses.find(
        (email) => email.id === user.primary_email_address_id,
      )?.email_address;
      const displayName = [user.first_name, user.last_name]
        .filter(Boolean)
        .join(" ");
      const role = config.adminClerkUserIds.includes(user.id) ? "admin" : "member";
      const synced = await client.query(
        `insert into users
           (clerk_user_id, email, display_name, avatar_url, role, last_seen_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (clerk_user_id) do update
           set email = excluded.email,
               display_name = excluded.display_name,
               avatar_url = excluded.avatar_url,
               role = excluded.role,
               updated_at = now()
         where users.deleted_at is null
         returning id`,
        [
          user.id,
          limited(primaryEmail?.toLowerCase(), 320),
          limited(displayName || user.username, 160),
          limited(user.image_url, 2_048),
          role,
        ],
      );
      if (synced.rows[0]) {
        await client.query(
          `insert into audit_events
             (actor_user_id, action, target_type, target_id, correlation_id, after_summary)
           values (null, $1, 'user', $2, $3::uuid, $4::jsonb)`,
          [
            `clerk.${event.type.replace(".", "_")}`,
            synced.rows[0].id,
            correlationId,
            JSON.stringify({ role, active: true }),
          ],
        );
      } else {
        ignored = true;
      }
    }
    await client.query("commit");
    return { accepted: true, ignored, eventType: event.type };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
