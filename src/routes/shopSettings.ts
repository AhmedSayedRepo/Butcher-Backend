import { Router } from 'express'
import { z } from 'zod'
import { OrderStatus, CashTransactionType, type Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { parseScaleBarcode, ScaleBarcodeConfigSchema } from '../lib/scaleBarcode.js'
import { auth } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { requireRole, requireCap } from '../middleware/rbac.js'
import { asyncHandler } from '../lib/asyncHandler.js'
import { HTTP_STATUS } from '../lib/httpStatus.js'
import { getOrCreateSettings } from '../lib/shopSettings.js'
import { encryptSecret, isEncryptionConfigured } from '../lib/encryption.js'
import { apiError, ERROR_CODES } from '../lib/errorCodes.js'

const router = Router()

// v3 replan (Phase J — pending-order alerting). Single-row config table:
// "how long is too long for a pending order" is shop policy, not a
// per-user preference. GET is open to any authed user (the dashboard's
// polling/alert logic needs to read the threshold regardless of role);
// PATCH is admin-only, same tier as user management — shop-wide policy
// changes, not a day-to-day cashier/manager action.

// v3.1 follow-up 9 (ADR-016), field names updated by ADR-017 (Brevo
// replaced Gmail SMTP): the raw settings row has `brevoApiKeyEncrypted`
// (AES-256-GCM ciphertext) — this is never sent to the client, not even as
// ciphertext (no reason to hand it out at all). `brevoApiKeySet` tells the
// UI whether a key is configured (server- or env-var-sourced) without
// revealing it, same "write-only secret field" pattern used by e.g.
// Stripe/GitHub API-key settings pages.
function toClientSettings<T extends { brevoApiKeyEncrypted: string | null }>(settings: T): Omit<T, 'brevoApiKeyEncrypted'> & { brevoApiKeySet: boolean } {
  const { brevoApiKeyEncrypted, ...rest } = settings
  const { env } = process
  const { BREVO_API_KEY: envKey } = env
  const brevoApiKeySet = (brevoApiKeyEncrypted !== null && brevoApiKeyEncrypted !== '') || (envKey !== undefined && envKey !== '')
  return { ...rest, brevoApiKeySet }
}

router.get('/', auth, asyncHandler(async (_req, res) => {
  const settings = await getOrCreateSettings()
  res.json(toClientSettings(settings))
}))

const MIN_ALERT_MINUTES = 1
const MIN_LOW_STOCK_THRESHOLD_KG = 0
const MIN_MAIL_SENDER_NAME_LENGTH = 1
// v3.1 follow-up 10 — receipt customization bounds. See the schema comments
// on UpdateShopSettingsSchema below for why each range is what it is.
const MIN_RECEIPT_WIDTH_MM = 40
const MAX_RECEIPT_WIDTH_MM = 210
const MIN_RECEIPT_HEIGHT_MM = 40
const MAX_RECEIPT_HEIGHT_MM = 2000
const MIN_RECEIPT_FONT_SCALE = 0.6
const MAX_RECEIPT_FONT_SCALE = 2
const MAX_RECEIPT_TEXT_LENGTH = 2000
// Logos are their own bound because they may be `data:` URLs, which are much
// longer than any text field. ~256 KB of base64 is roughly a 190 KB image —
// generous for a logo, small enough that it can't be used to smuggle bulk
// storage into the settings row. The client downscales before upload, so
// hitting this ceiling means someone bypassed the form.
const MAX_LOGO_URL_LENGTH = 262144
const MIN_SHOP_NAME_LENGTH = 1

// A logo value is one of two things and nothing else: an http(s) URL, or an
// inline image. Without this check the field is a free-form text column that
// gets rendered into an <img src> on every page and every receipt, which is
// how you end up serving `javascript:` or `data:text/html` to your own staff.
// The size ceiling above is a separate concern — this one is about *what* the
// string is, not how long it is.
// `v` flag per eslint-config-love's require-unicode-regexp. No behaviour
// change here — the pattern has no character classes, which is where `v`
// mode's stricter rules apply — but it's the house standard and the linter is
// right that a regex tested against arbitrary user input should be explicit
// about its Unicode semantics.
const LOGO_URL_PATTERN = /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,)/v
const LOGO_URL_MESSAGE = 'Logo must be an https:// URL or an uploaded image'

// `null` clears the logo; an empty string is treated the same way by the
// handler, so both bypass the pattern.
const logoUrlField = z
  .string()
  .max(MAX_LOGO_URL_LENGTH)
  .refine(v => v === '' || LOGO_URL_PATTERN.test(v), { message: LOGO_URL_MESSAGE })
  .nullable()
  .optional()

// v3.1 follow-up 5 (Settings page): defaultLowStockThresholdKg/mailSenderName
// added alongside the existing Phase J fields — same single-row shop-policy
// table, same admin-only PATCH gate.
//
// v3.1 follow-up 9 (ADR-016), renamed by ADR-017: brevoSenderEmail/
// brevoApiKey are both plain `z.string()` (not `.min(1)`) so an explicit
// empty string means "clear this field" — distinct from omitting the key
// entirely, which means "leave it as-is". See the PATCH handler below for
// how that distinction is used.
const UpdateShopSettingsSchema = z.object({
  pendingOrderAlertMinutes: z.number().int().min(MIN_ALERT_MINUTES).optional(),
  alertSoundEnabled: z.boolean().optional(),
  defaultLowStockThresholdKg: z.number().gt(MIN_LOW_STOCK_THRESHOLD_KG).optional(),
  mailSenderName: z.string().min(MIN_MAIL_SENDER_NAME_LENGTH).optional(),
  brevoSenderEmail: z.string().optional(),
  brevoApiKey: z.string().optional(),
  // v3.1 follow-up 10 — receipt customization. Bounds are deliberately wide
  // but not unbounded: a width outside 40–210mm is a typo rather than a real
  // printer (57mm and 80mm are the common thermal rolls; 210mm is A4), and a
  // font scale outside 0.6–2 produces a receipt that's unreadable or wastes
  // half a roll per sale.
  receiptWidthMm: z.number().int().min(MIN_RECEIPT_WIDTH_MM).max(MAX_RECEIPT_WIDTH_MM).optional(),
  receiptHeightMm: z.number().int().min(MIN_RECEIPT_HEIGHT_MM).max(MAX_RECEIPT_HEIGHT_MM).nullable().optional(),
  receiptFontScale: z.number().min(MIN_RECEIPT_FONT_SCALE).max(MAX_RECEIPT_FONT_SCALE).optional(),
  receiptHeaderText: z.string().max(MAX_RECEIPT_TEXT_LENGTH).nullable().optional(),
  receiptFooterText: z.string().max(MAX_RECEIPT_TEXT_LENGTH).nullable().optional(),
  receiptLogoUrl: logoUrlField,
  appLogoUrl: logoUrlField,
  receiptShowShopName: z.boolean().optional(),
  receiptShowPhone: z.boolean().optional(),
  receiptShowAddress: z.boolean().optional(),
  receiptShowOrderNo: z.boolean().optional(),
  receiptShowCode: z.boolean().optional(),
  receiptShowCashier: z.boolean().optional(),
  receiptShowDateTime: z.boolean().optional(),
  receiptShowItems: z.boolean().optional(),
  receiptShowCustomer: z.boolean().optional(),
  receiptShowAddressOfCustomer: z.boolean().optional(),
  shopName: z.string().min(MIN_SHOP_NAME_LENGTH).max(MAX_RECEIPT_TEXT_LENGTH).optional(),
  shopPhone: z.string().max(MAX_RECEIPT_TEXT_LENGTH).nullable().optional(),
  shopAddress: z.string().max(MAX_RECEIPT_TEXT_LENGTH).nullable().optional(),
  // v3.1 follow-up 10b — display label only; the value is per-order.
  deliveryNameLabel: z.string().min(MIN_SHOP_NAME_LENGTH).max(MAX_RECEIPT_TEXT_LENGTH).optional(),
  // v3.4 — flat delivery fee. Non-negative rather than positive: zero with the
  // toggle on is a legitimate "deliveries are free right now".
  deliveryFeeEnabled: z.boolean().optional(),
  deliveryFee: z.number().nonnegative().optional(),
  // v3.5 — per-shop notification recipient. Plain string (not .email()) so ''
  // can clear it, same convention as brevoSenderEmail; the PATCH handler maps
  // '' → null below.
  notifyEmail: z.string().optional(),
  // v3.3 — the whole scale-barcode scheme, validated as one object. Turning
  // the feature off is `enabled: false` inside the config, not clearing it, so
  // this never needs to write a JSON null (which Prisma handles specially).
  scaleBarcodeConfig: ScaleBarcodeConfigSchema.optional()
})

type UpdateShopSettingsInput = z.infer<typeof UpdateShopSettingsSchema>

// Builds the Prisma update object from the validated body. Extracted from the
// handler purely to keep its cyclomatic complexity under the lint threshold:
// the four fields that need special mapping (three that treat '' as "clear",
// one JSON blob) are all branchy, and stacking them in the route pushed it
// over. `''` → null is the shared convention that lets a field be cleared
// distinctly from being left untouched (omitted key).
function toShopSettingsUpdate(data: UpdateShopSettingsInput): Prisma.ShopSettingsUpdateInput {
  const { brevoSenderEmail, brevoApiKey, scaleBarcodeConfig, notifyEmail, ...rest } = data
  return {
    ...rest,
    ...(brevoSenderEmail === undefined ? {} : { brevoSenderEmail: brevoSenderEmail === '' ? null : brevoSenderEmail }),
    ...(brevoApiKey === undefined ? {} : { brevoApiKeyEncrypted: brevoApiKey === '' ? null : encryptSecret(brevoApiKey) }),
    // Now that the return type is annotated, Prisma accepts the validated
    // config object directly — the InputJsonValue assertion that was needed
    // when this was inlined is redundant here.
    ...(scaleBarcodeConfig === undefined ? {} : { scaleBarcodeConfig }),
    ...(notifyEmail === undefined ? {} : { notifyEmail: notifyEmail === '' ? null : notifyEmail })
  }
}

router.patch('/', auth, requireRole('admin'), asyncHandler(async (req, res) => {
  const parsed = UpdateShopSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  const { data } = parsed

  if (data.brevoApiKey !== undefined && data.brevoApiKey !== '' && !isEncryptionConfigured()) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(
      ERROR_CODES.ENCRYPTION_KEY_MISSING,
      'SETTINGS_ENCRYPTION_KEY is not configured on the server, so a Brevo API key can\'t be saved here yet. Ask whoever deploys this app to set that env var, or continue using BREVO_API_KEY as an env var for now.'
    ))
    return
  }

  const current = await getOrCreateSettings()
  const updated = await prisma.shopSettings.update({
    where: { id: current.id },
    data: toShopSettingsUpdate(data)
  })
  res.json(toClientSettings(updated))
}))

// v3.3 — the live "paste a sample barcode" tester behind the scale settings.
// Runs the REAL parser against the config being edited (which may be unsaved),
// so what the admin sees in the tester is exactly what a scan will do. Also
// reports which product the parsed item code maps to, so a wrong position
// shows up as "matched the wrong product" rather than a silent success.
const ScaleTestSchema = z.object({
  config: ScaleBarcodeConfigSchema,
  sample: z.string()
})

router.post('/scale-barcode/test', auth, requireRole('admin'), asyncHandler(async (req, res) => {
  const parsed = ScaleTestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(apiError(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', undefined, parsed.error.flatten()))
    return
  }
  // `parsed.data` is a member expression, and prefer-destructuring won't
  // destructure from one — bind it to an identifier first (as the PATCH
  // handler above does).
  const { data } = parsed
  const { config, sample } = data
  const result = parseScaleBarcode(sample, config)
  if (result === null) {
    res.json({ matched: false })
    return
  }
  const product = await prisma.product.findFirst({ where: { scaleItemCode: result.itemCode } })
  res.json({
    matched: true,
    itemCode: result.itemCode,
    value: result.value,
    valueType: result.valueType,
    productName: product?.name ?? null
  })
}))

const ZERO = 0
const EPOCH = new Date(ZERO)

// v3.1 replan (Phase L — closing day, ADR-015). Snapshots everything since
// the last closing (orders since `lastClosedAt`, or the beginning of time
// for the very first closing) into a permanent DailyClosing row, then
// resets `dailyOrderCounter` to 0 so tomorrow's first order is #1 again.
// Gated by `manage_cash` — same tier as every other Cash Management action
// — rather than admin-only, since this is a routine end-of-shift task, not
// a shop-policy change like PATCH / above.
router.post('/close-day', auth, requireCap('manage_cash'), asyncHandler<AuthRequest>(async (req, res) => {
  if (req.user === undefined) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json(apiError(ERROR_CODES.UNAUTHORIZED, 'Unauthorized'))
    return
  }
  const { user } = req
  const settings = await getOrCreateSettings()
  const since = settings.lastClosedAt ?? EPOCH

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: since }, status: { notIn: [OrderStatus.DRAFT, OrderStatus.CANCELLED] } }
  })
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.totalAmount), ZERO)

  const cashTx = await prisma.cashTransaction.findMany({ where: { createdAt: { gte: since } } })
  const cashIn = cashTx.filter((t) => t.type === CashTransactionType.IN).reduce((sum, t) => sum + Number(t.amount), ZERO)
  const cashOut = cashTx.filter((t) => t.type === CashTransactionType.OUT).reduce((sum, t) => sum + Number(t.amount), ZERO)

  const closing = await prisma.$transaction(async (tx) => {
    const record = await tx.dailyClosing.create({
      data: {
        closedBy: user.id,
        orderCount: orders.length,
        totalRevenue,
        cashIn,
        cashOut,
        netPosition: cashIn - cashOut
      }
    })
    await tx.shopSettings.update({
      where: { id: settings.id },
      data: { dailyOrderCounter: ZERO, lastClosedAt: record.closedAt }
    })
    return record
  })

  res.status(HTTP_STATUS.CREATED).json(closing)
}))

const RECENT_CLOSINGS_LIMIT = 30

router.get('/closings', auth, requireCap('manage_cash'), asyncHandler(async (_req, res) => {
  const closings = await prisma.dailyClosing.findMany({
    orderBy: { closedAt: 'desc' },
    take: RECENT_CLOSINGS_LIMIT,
    include: { closedByUser: { select: { email: true } } }
  })
  res.json(closings)
}))

export default router
