import logger from "./logger";

type FileEventName =
  | "Open File Viewer"
  | "Upload File"
  | "Upload File Initiated"
  | "Blob Store Upload Started"
  | "Blob Store Upload Completed"
  | "Upload File Completed"
  | "Remove File";

interface BaseFileEventProps {
  conversationId?: string;
  messageId?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  origin?: string;
  client?: string;
  status?: string;
  useCase?: string;
  uploadEntry?: string;
}

/**
 * Lightweight internal event tracker for file upload lifecycle.
 * This is intentionally generic so it can be wired to Segment or
 * another analytics sink later without changing call sites.
 */
export function trackFileEvent(
  event: FileEventName,
  properties: BaseFileEventProps = {}
) {
  try {
    console.log("[FileEvent]", event, properties);

    logger.info("FileEvent", {
      event,
      properties,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Never let analytics break the main flow
  }
}


