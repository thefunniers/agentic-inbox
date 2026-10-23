import { sendEmail, type SendEmailParams } from "../email-sender";
import type { Env } from "../types";
import { AttachmentError, deleteAttachments, type StoredAttachment } from "./attachments";

/** Do not report success or keep a sent copy when the provider rejects delivery. */
export async function deliverStoredEmail(
	env: Env,
	mailbox: { deleteEmail(id: string): Promise<unknown> },
	emailId: string,
	params: SendEmailParams,
	attachments: StoredAttachment[],
) {
	try {
		return await sendEmail(env.EMAIL, params);
	} catch (error) {
		await mailbox.deleteEmail(emailId).catch((cleanupError) => console.error("Failed send cleanup:", cleanupError));
		await deleteAttachments(env.BUCKET, attachments).catch((cleanupError) => console.error("Failed attachment cleanup:", cleanupError));
		console.error("Email delivery rejected:", error);
		const detail = error instanceof Error ? error.message : "Please try again.";
		throw new AttachmentError(`Email was not sent. ${detail}`, 502);
	}
}
