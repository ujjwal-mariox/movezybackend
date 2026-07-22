import { Request, Response } from "express";
import VehicleType from "../models/vehicle-type.model";
import PromoCode from "../models/promo-code.model";
import { FareConfig } from "../models/app-config.model";

/**
 * GET /v1/api/home
 * Single home page API for the user app.
 * Returns active vehicle types, active promo banners, and fare config.
 */
export const getHomePage = async (req: Request, res: Response) => {
  // Fetch active, non-deleted vehicle types sorted by sortOrder
  const vehicleTypes = await VehicleType.find({
    isActive: true,
    isDeleted: false,
    showOnHomeScreen: { $ne: false },
  })
    // lengthFt/breadthFt/heightFt were missing here, so the app could never
    // render the design's "20kg, 2 Feet" subtitle and silently fell back to
    // the price — the dimensions existed on the record but never left the API.
    .select(
      "name description maxWeightKg lengthFt breadthFt heightFt baseFare perKmRate perMinuteRate image icon sortOrder allowIntraCity allowInterCity minRangeKm maxRangeKm showOnHomeScreen"
    )
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  // Fetch active, non-expired promo codes for banners
  const now = new Date();
  const promoBanners = await PromoCode.find({
    isActive: true,
    isDeleted: false,
    validFrom: { $lte: now },
    validTo: { $gte: now },
  })
    .select(
      "code description discountType discountValue maxDiscount minOrderValue"
    )
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  // Fetch fare config (GST, platform fee, etc.)
  const fareConfig = await FareConfig.findOne({ isActive: true })
    .select("gstPercentage minimumFare")
    .lean();

  res.locals.data = {
    vehicleTypes,
    promoBanners,
    fareConfig,
  };
};

/**
 * Simple in-memory image cache to avoid re-downloading from S3 on every request.
 * Key: image URL, Value: { buffer, contentType, cachedAt }
 * Entries expire after 1 hour. Max 50 entries (LRU eviction by oldest).
 */
const IMAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const IMAGE_CACHE_MAX = 50;
const imageCache = new Map<string, { buffer: Buffer; contentType: string; cachedAt: number }>();

function evictOldestCacheEntry() {
  if (imageCache.size <= IMAGE_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, val] of imageCache) {
    if (val.cachedAt < oldestTime) {
      oldestTime = val.cachedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) imageCache.delete(oldestKey);
}

/**
 * Allowed domains for image proxy to prevent SSRF.
 */
const ALLOWED_IMAGE_DOMAINS = [
  "bank-ster-dev.s3.ap-south-1.amazonaws.com",
  "bank-ster-dev.s3.amazonaws.com",
  "s3.ap-south-1.amazonaws.com",
];

function isAllowedImageUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    // Block private/internal IPs
    const hostname = parsed.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("172.") ||
      hostname === "169.254.169.254" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".internal")
    ) {
      return false;
    }
    return ALLOWED_IMAGE_DOMAINS.length === 0 || ALLOWED_IMAGE_DOMAINS.some((d) => hostname.endsWith(d));
  } catch {
    return false;
  }
}

/**
 * GET /v1/api/home/image-proxy?url=<encoded_url>
 * Proxies external images through the backend so the Android emulator
 * (which can only reach 10.0.2.2 / localhost) can load any image URL.
 * Results are cached in memory for 1 hour.
 */
export const imageProxy = async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).send("Missing url parameter");
  }

  if (!isAllowedImageUrl(imageUrl)) {
    return res.status(403).send("URL not allowed");
  }

  try {
    // Check in-memory cache first
    const cached = imageCache.get(imageUrl);
    if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL) {
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Cache", "HIT");
      return res.send(cached.buffer);
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).send("Image fetch failed");
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());

    // Store in cache
    imageCache.set(imageUrl, { buffer, contentType, cachedAt: Date.now() });
    evictOldestCacheEntry();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Cache", "MISS");
    res.send(buffer);
  } catch (err: any) {
    console.error("Image proxy error:", err.message);
    res.status(502).send("Failed to fetch image");
  }
};
