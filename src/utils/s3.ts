import { Upload } from "@aws-sdk/lib-storage";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import config from "../config";
import { Express } from "express";

interface UploadFile {
  name: string;
  mimetype: string;
  buffer: Buffer;
}

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Sanitize filename to prevent path traversal
 */
function sanitizeFilename(originalname: string): string {
  const basename = originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  return basename.substring(0, 100); // limit length
}

/**
 * Upload single file
 */
export const uploadFileToAws = async (files: Express.Multer.File[]) => {
  if (!files || files.length === 0) {
    throw new Error("Invalid file buffer");
  }

  const fileName = `uploads/${Date.now()}_${sanitizeFilename(files[0].originalname)}`;

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.aws.bucket,
      Key: fileName,
      Body: files[0].buffer,
      ContentType: files[0].mimetype,
    },
    queueSize: 3,
  });

  const data = await upload.done();

  return {
    images: data.Location, // keep same key for backward compatibility
  };
};

/**
 * Upload a raw buffer (for files we generate server-side rather than receive
 * via Multer, e.g. invoice PDFs). Returns the public URL.
 */
export const uploadBufferToAws = async (
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> => {
  if (!buffer || buffer.length === 0) {
    throw new Error("Invalid file buffer");
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
    queueSize: 3,
  });

  const data = await upload.done();
  return data.Location as string;
};

/**
 * Upload multiple files (Multer based)
 */
export const uploadMultipleFilesToAws = async (
  files: Express.Multer.File[] | Express.Multer.File
) => {
  const fileArray = Array.isArray(files) ? files : [files];

  const uploadPromises = fileArray.map(async (file) => {
    const fileName = `uploads/${Date.now()}_${sanitizeFilename(file.originalname)}`;

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: config.aws.bucket,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
      },
      queueSize: 3,
    });

    const data = await upload.done();
    return data.Location as string;
  });

  const locations = await Promise.all(uploadPromises);

  return {
    images: locations, // array of URLs
  };
};

export default {
  uploadFileToAws,
  uploadBufferToAws,
  uploadMultipleFilesToAws,
};

/**
 * Delete stored files by the URLs we saved for them (profile photos, licence
 * and RC images) — used when a deleted account is wiped. Only keys under
 * uploads/ in our bucket are touched; anything else is ignored. Never throws:
 * a storage hiccup must not stop the rest of the wipe. Returns how many were
 * removed.
 */
export const deleteFilesFromAws = async (
  urls: (string | null | undefined)[],
): Promise<number> => {
  const keys = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      const u = new URL(url);
      if (!u.hostname.includes(config.aws.bucket)) continue;
      const key = decodeURIComponent(u.pathname.replace(/^\//, ""));
      if (key.startsWith("uploads/")) keys.add(key);
    } catch {
      /* not a URL we stored */
    }
  }
  if (keys.size === 0) return 0;
  try {
    const res = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: config.aws.bucket,
        Delete: { Objects: [...keys].map((Key) => ({ Key })), Quiet: true },
      }),
    );
    return keys.size - (res.Errors?.length || 0);
  } catch (err: any) {
    console.warn(`[s3] delete of ${keys.size} files failed: ${err?.message || err}`);
    return 0;
  }
};
