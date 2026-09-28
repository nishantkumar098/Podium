export interface ProjectDto {
  id: string;
  name: string;
  type: string;
  status: string;
  health: "GREEN" | "AMBER" | "RED";
  revenue: string | number;
  estCost: string | number;
  actCost: string | number;
  eventDate: string;
  city: { id: string; name: string };
  client: { id: string; name: string };
  pm: { id: string; name: string };
}

export interface TaskDto {
  id: string;
  projectId: string;
  name: string;
  status: string;
  priority: string;
  dueAt: string | null;
  ownerId: string;
  updatedAt: string;
}

export interface RiskDto {
  id: string;
  projectId: string;
  title: string;
  severity: string;
  status: string;
  ownerId: string;
}

export interface ApprovalDto {
  id: string;
  projectId: string;
  title: string;
  type: string;
  status: string;
  approverRef: string;
}

export interface InvoiceDto {
  id: string;
  invoiceNo: string;
  docType: "TAX_INVOICE" | "ESTIMATE";
  status: string;
  total: string | number;
  dueDate: string;
  client: { name: string };
  project: { name: string };
}

export interface FlowStepDto {
  id: string;
  key: string;
  name: string;
  role: string;
  status: string;
  ownerId: string;
  readyAt: string | null;
  startedAt: string | null;
  doneAt: string | null;
}

export interface FlowInstanceDto {
  id: string;
  name: string;
  status: string;
  steps: FlowStepDto[];
  project: { id: string; name: string; cityId: string };
}

// ---------------------------------------------------------------- invoices
// Phase A. The detail shape mirrors InvoicesService.get()'s include set
// exactly — every money value arrives as a string (Prisma Decimal) and is
// parsed only for display. The server's number is always the authoritative
// one; nothing here recomputes a total for anything but a live preview.

export interface InvoiceItemDto {
  id: string;
  description: string;
  detail: string | null;
  qty: string | number;
  unit: string | null;
  rate: string | number;
  discountPct: string | number;
  scope: "FIXED" | "VARIABLE";
  hsnSac: string | null;
}

export interface PaymentDto {
  id: string;
  amount: string | number;
  method: string;
  receivedAt: string;
}

export interface AdjustmentNoteDto {
  id: string;
  amount: string | number;
  reason: string;
  createdAt: string;
}

export interface InvoiceDetailDto {
  id: string;
  invoiceNo: string;
  docType: "TAX_INVOICE" | "ESTIMATE";
  status: string;
  issueDate: string | null;
  dueDate: string;
  placeOfSupply: string;
  taxableAmount: string | number;
  cgst: string | number;
  sgst: string | number;
  igst: string | number;
  total: string | number;
  client: { id: string; name: string; email: string | null; gstin: string | null };
  project: { id: string; name: string };
  city: { id: string; name: string; code: string; gstStateCode: string };
  items: InvoiceItemDto[];
  payments: PaymentDto[];
  creditNotes: AdjustmentNoteDto[];
  debitNotes: AdjustmentNoteDto[];
}

export interface ClientOptionDto {
  id: string;
  name: string;
  cityId: string | null;
  gstStateCode: string | null;
}

export interface CityOptionDto {
  id: string;
  name: string;
  code: string;
  gstStateCode: string;
}

// ------------------------------------------------------- budgets & expenses
export interface ExpenseDto {
  id: string;
  category: string;
  amount: string | number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REIMBURSED";
  note: string | null;
  incurredAt: string;
  decidedAt: string | null;
  reimbursedAt?: string | null;
  decisionReason: string | null;
  project: { id: string; name: string };
  user: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
}

export interface BudgetVarianceDto {
  projectId: string;
  hasBudget: boolean;
  lines: Array<{
    category: string;
    plannedAmount: number;
    actualAmount: number;
    variance: number;
    variancePct: number | null;
  }>;
  unbudgetedSpend: Array<{ category: string; actualAmount: number }>;
  /** Purchase orders carry no category, so this is never split across lines. */
  purchaseOrderSpend: number;
  totals: { planned: number; actualExpenses: number; actualAllCommitted: number; variance: number };
}

export interface BudgetDto {
  id: string;
  projectId: string;
  lines: Array<{ id: string; category: string; plannedAmount: string | number }>;
}

// -------------------------------------------------------------- reports/P&L
export interface PnlActualsDto {
  kind: "actuals";
  scope: "company" | "city" | "project";
  from: string;
  to: string;
  hasData: boolean;
  explanation: string | null;
  revenue: { netRevenue: number; gstCollected: number; grossInvoiced: number; invoiceCount: number };
  collections: { received: number; outstanding: number; paymentCount: number };
  costs: { expenses: number; purchaseOrders: number; total: number };
  margin: { grossMargin: number; grossMarginPct: number | null };
}

export interface PnlByCityDto {
  kind: "actuals";
  hasData: boolean;
  cities: Array<{ city: { id: string; name: string; code: string } } & PnlActualsDto>;
}

export interface CashFlowDto {
  kind: "actuals";
  from: string;
  to: string;
  hasData: boolean;
  explanation: string | null;
  series: Array<{ month: string; inflow: number; outflow: number; net: number }>;
  totals: { inflow: number; outflow: number; net: number };
}

export interface ForecastDto {
  kind: "forecast";
  basis: "none" | "caller_supplied_baseline" | "trailing_12_month_actuals";
  hasData: boolean;
  monthlyBaseline?: number;
  explanation: string;
  series: Array<{ month: string; seasonalityIndex: number; projectedNetRevenue: number }>;
}

// -------------------------------------------------------------- procurement
export interface VendorOptionDto {
  id: string;
  name: string;
  category: string;
  status: string;
}

export interface VendorDto {
  id: string;
  name: string;
  category: string | null;
  cityId: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  rating: string | number | null;
  gstin: string | null;
  status: "PREFERRED" | "APPROVED" | "BLACKLISTED";
  /** From AMM's vendor sheet. */
  brand: string | null;
  website: string | null;
  pan: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  upiId: string | null;
  paymentTerms: string | null;
  creditDays: number | null;
  openingBalance: string | number | null;
  lastPaymentAt: string | null;
  nextPaymentDueAt: string | null;
  remarks: string | null;
}

export interface InventoryBalanceDto {
  item: { id: string; sku: string; name: string; unit: string; standardCost: string | number };
  location: { id: string; name: string; city: { id: string; name: string } };
  qtyOnHand: number;
  reorderLevel: number;
}

export interface ApprovalRefDto {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requesterId: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface PurchaseOrderRefDto {
  id: string;
  status: string;
  total: string | number;
}

export interface PurchaseRequestDto {
  id: string;
  item: string;
  vendorId: string;
  vendor: { id: string; name: string };
  projectId: string | null;
  project: { id: string; name: string } | null;
  cityId: string | null;
  amount: string | number;
  status: string;
  notes: string | null;
  requestedById: string | null;
  approvals: ApprovalRefDto[];
  purchaseOrders: PurchaseOrderRefDto[];
  createdAt: string;
}

export interface PurchaseOrderItemDto {
  id: string;
  skuId: string;
  qtyOrdered: number;
  unitPrice: string | number;
  sku: { id: string; sku: string; name: string; unit: string };
}

export interface GoodsReceiptDto {
  id: string;
  receivedQty: Record<string, number>;
  locationId: string;
  note: string | null;
  receivedAt: string;
  receivedById: string;
}

export interface PurchaseOrderDto {
  id: string;
  prId: string;
  vendorId: string;
  vendor: { id: string; name: string };
  total: string | number;
  status: string;
  items: PurchaseOrderItemDto[];
  goodsReceipts: GoodsReceiptDto[];
  purchaseRequest: { id: string; item: string; cityId: string | null };
  createdAt: string;
}

// --------------------------------------------------------------- event day
export interface RunsheetItemDto {
  id: string;
  scheduledTime: string;
  text: string;
  ownerId: string;
  doneAt: string | null;
  sortOrder: number;
}

export interface RunsheetDto {
  id?: string;
  projectId: string;
  items: RunsheetItemDto[];
}

export interface CheckinDto {
  id: string;
  projectId: string;
  userId: string;
  /** Resolved server-side (BUG-011) — the checker-in need not be a project member. */
  userName: string;
  checkedInAt: string;
}

export interface IncidentDto {
  id: string;
  projectId: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  text: string;
  reportedById: string;
  /** Resolved server-side (BUG-011) — the reporter need not be a project member. */
  reportedByName: string;
  raisedRiskId: string | null;
  createdAt: string;
}

// -------------------------------------------------------------- playbooks
export interface PlaybookTaskDto {
  name: string;
  dueOffsetDays?: number;
}

export interface PlaybookDto {
  id: string;
  name: string;
  eventType: string;
  defaultStages: string[];
  defaultTasks: PlaybookTaskDto[];
  defaultFlowTemplateIds: string[];
  createdAt: string;
}

export interface FlowTemplateOptionDto {
  id: string;
  name: string;
  category: string;
}

// ----------------------------------------------------------- menu costing
export interface InventoryItemOptionDto {
  id: string;
  sku: string;
  name: string;
  unit: string;
  sizeMl: number | null;
  standardCost: string | number;
}

export interface RecipeItemDto {
  id: string;
  /** Linked stock item, if any — recipe-book lines are free text. */
  skuId: string | null;
  /** Name as written ("Bourbon whiskey"). */
  ingredient: string;
  /** As written; null = "as needed". */
  qty: string | number | null;
  /** Top of a range (8–10 leaves). */
  qtyMax: string | number | null;
  unit: string;
  note: string | null;
  position: number;
  /** Volume in ml (0 for non-volume units). */
  qtyMl: number;
  costable: boolean;
  cost: number | null;
  item: { id: string; sku: string; name: string; unit: string; sizeMl: number | null } | null;
}

export interface RecipeCostingDto {
  ingredientCost: number | null;
  garnishCost: number;
  totalCost: number | null;
  margin: number | null;
  marginPct: number | null;
  allCostable: boolean;
}

export interface RecipeDto {
  id: string;
  name: string;
  glass: string;
  spirit: string | null;
  method: string | null;
  garnish: string | null;
  notes: string | null;
  garnishCost: string | number;
  price: string | number;
  items: RecipeItemDto[];
  costing: RecipeCostingDto;
}

// -------------------------------------------------------------- documents
export type DocumentType = "CONTRACT" | "DESIGN" | "CREATIVE" | "PURCHASE_ORDER" | "GOVERNMENT_PERMIT" | "GUEST_LIST" | "OTHER";

export interface DocumentVersionDto {
  id: string;
  versionNo: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string;
  uploadedBy?: { id: string; name: string };
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  icon: string | null;
  text: string;
  readAt: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string;
}

export interface DocumentDto {
  id: string;
  name: string;
  type: DocumentType;
  projectId: string | null;
  project: { id: string; name: string } | null;
  versions: DocumentVersionDto[];
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------- CRM / pipeline
export type LeadStage = "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "WON" | "LOST";

export interface LeadDto {
  id: string;
  name: string;
  stage: LeadStage;
  kind: "PIPELINE" | "COLD_PROSPECT";
  value: string | number | null;
  ownerId: string | null;
  cityId: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  designation: string | null;
  address: string | null;
  eventType: string | null;
  pax: number | null;
  eventDate: string | null;
  eventDateText: string | null;
  remarks: string | null;
  source: string | null;
  convertedClientId: string | null;
  convertedProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadListResponse {
  total: number;
  limit: number;
  offset: number;
  rows: LeadDto[];
}

/** Phase F.5's bare active-user list (GET /users) — only Founder/Admin/Operations can reach it. */
export interface UserSummaryDto {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

// ------------------------------------------------------------- automation
export interface AutomationRuleDto {
  id: string;
  name: string;
  triggerType: string;
  triggerConfig: unknown;
  actions: Array<{ type?: string; config?: unknown } | string>;
  isEnabled: boolean;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  ruleId: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "RETRYING" | "BLOCKED";
  error: string | null;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  rule: { name: string; triggerType: string };
}
