import { Request, Response } from "express";
import {
  DATASETS,
  parseRange,
  renderPdf,
  renderXlsx,
} from "../../services/export.service";
import { auditFromRequest } from "./audit-log.controller";

/**
 * GET /admin/exports                      → the catalogue (for the Exports page)
 * GET /admin/exports/:dataset?format=xlsx|pdf&dateFrom&dateTo
 *                                         → the file, generated server-side
 *
 * Streams a real .xlsx / .pdf built from live records (see export.service).
 * Every export is audit-logged: who pulled which dataset over which range is
 * exactly the kind of trail a financial audit asks for.
 */

export const listExportDatasets = async (_req: Request, res: Response) => {
  res.locals.data = {
    datasets: Object.values(DATASETS).map((d) => ({
      key: d.key,
      title: d.title,
      scope: d.scope,
      columns: d.columns.map((c) => c.header),
    })),
  };
};

export const downloadExport = async (req: Request, res: Response) => {
  const dataset = DATASETS[String(req.params.dataset)];
  if (!dataset) {
    return res.status(404).json({ success: false, message: "Unknown dataset" });
  }
  const format = String(req.query.format || "xlsx").toLowerCase();
  if (format !== "xlsx" && format !== "pdf") {
    return res.status(400).json({ success: false, message: "format must be xlsx or pdf" });
  }
  const range = parseRange(req.query);

  const rows = await dataset.rows(range);
  const buffer =
    format === "xlsx"
      ? await renderXlsx(dataset, rows, range)
      : await renderPdf(dataset, rows, range);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `movezy-${dataset.key}-${stamp}.${format}`;

  await auditFromRequest(req, {
    action: "EXPORT",
    module: "reports",
    targetId: dataset.key,
    targetType: "Export",
    description: `Exported ${dataset.title} as ${format.toUpperCase()} (${rows.length} rows, ${range.from ? range.from.toISOString().slice(0, 10) : "all"} → ${range.to ? range.to.toISOString().slice(0, 10) : "now"})`,
  });

  res.setHeader(
    "Content-Type",
    format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/pdf",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.status(200).end(buffer);
};
