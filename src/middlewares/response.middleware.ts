import { Request, Response, NextFunction } from "express";
import messages, { MessageKey } from "../utils/messages";

const ResponseMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
  customMsg: string = ""
) => {
  console.log("ResponseMiddleware => called");

  const data = req.rData ?? {};
  const code = req.rCode ?? 1;

  // Fall back to req.msg itself when it isn't in the messages map. ~70 keys used
  // by controllers were never added, and an unmapped key produced
  // `message: undefined` — which JSON drops, so the response had NO message and
  // every client toast degraded to its generic hardcoded fallback ("Could not
  // accept booking" instead of "Booking already assigned to another driver").
  // Controllers also set free-text sentences via req.msg; those now pass through.
  const message =
    customMsg || (req.msg && messages()[req.msg as MessageKey]) || req.msg || "success";

  switch (code) {
    case 3:
      return res.status(401).json({ code, message, data });
    case 4:
      return res.status(403).json({ code, message, data });
    case 0:
      return res.status(400).json({ code, message, data });
    case 5:
      return res.status(404).json({ code, message, data });
    default:
      return res.json({ code, message, data });
  }
};

export default ResponseMiddleware;
