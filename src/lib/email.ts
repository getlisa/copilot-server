import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
import logger from "./logger";
dotenv.config();

/**
 * SendGrid Web API wrapper (HTTPS via @sendgrid/mail — not SMTP relay).
 *
 * Mirrors the env-driven style of src/lib/s3.ts. The API key is set lazily so the app
 * boots fine without it; callers should gate on isEmailConfigured() and surface a 503
 * when email is requested but not configured.
 *
 * Env:
 *   SENDGRID_API_KEY    required to actually send
 *   SENDGRID_FROM_EMAIL company/default "from" address (must be a verified sender /
 *                       authenticated domain in SendGrid)
 *   SENDGRID_FROM_NAME  optional default display name
 */

const apiKey = process.env.SENDGRID_API_KEY;
let configured = false;

if (apiKey) {
  sgMail.setApiKey(apiKey);
  configured = true;
} else {
  console.warn("[email] SENDGRID_API_KEY is not set. Email sending is disabled until configured.");
}

export function isEmailConfigured(): boolean {
  return configured;
}

export const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "";
export const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  type: string; // MIME type, e.g. "application/pdf"
}

export interface SendEmailParams {
  to: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachment?: EmailAttachment;
}

/** Send a single email via SendGrid. Throws if SENDGRID_API_KEY is not configured. */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!configured) {
    throw new Error("Email not configured (SENDGRID_API_KEY missing)");
  }

  const msg: sgMail.MailDataRequired = {
    to: params.to,
    from: params.fromName ? { email: params.from, name: params.fromName } : params.from,
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
    ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    ...(params.cc ? { cc: params.cc } : {}),
    ...(params.attachment
      ? {
          attachments: [
            {
              content: params.attachment.content.toString("base64"),
              filename: params.attachment.filename,
              type: params.attachment.type,
              disposition: "attachment",
            },
          ],
        }
      : {}),
  };

  try {
    await sgMail.send(msg);
  } catch (err: any) {
    // SendGrid puts the useful detail in err.response.body
    const detail = err?.response?.body ? JSON.stringify(err.response.body) : err?.message;
    logger.error("SendGrid send failed", { to: params.to, detail });
    throw new Error(`Email send failed: ${detail}`);
  }
}
