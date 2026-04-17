import { useState } from "react";
import {
  addCase,
  generateCaseNo,
  SLA_DAYS,
  type CasePriority,
  type CaseCategory,
} from "@/lib/assr-store";
import { CheckCircle2, Send, ArrowLeft } from "lucide-react";

const BRANDS = ["AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO"] as const;

const CATEGORIES: { value: CaseCategory; label: string }[] = [
  { value: "WARRANTY_SERVICE_REQUEST", label: "Warranty Service Request" },
  { value: "INSTALLATION_ASSEMBLY_ISSUE", label: "Installation / Assembly Issue" },
  { value: "PRODUCT_DEFECT", label: "Product Defect" },
  { value: "DELIVERY_DAMAGE", label: "Delivery Damage" },
  { value: "MISSING_PARTS", label: "Missing Parts" },
  { value: "CUSTOMER_COMPLAINT", label: "Customer Complaint" },
  { value: "RETURN_EXCHANGE", label: "Return / Exchange" },
  { value: "WRONG_ITEM", label: "Wrong Item Delivered" },
  { value: "COLOUR_MISMATCH", label: "Colour Mismatch" },
  { value: "FABRIC_ISSUE", label: "Fabric Issue" },
  { value: "STRUCTURE_DAMAGE", label: "Structure / Frame Damage" },
  { value: "OTHERS", label: "Others" },
];

const PRIORITIES: { value: CasePriority; label: string }[] = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const inputClass =
  "h-10 w-full rounded-md border border-[#DDE5E5] px-3 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]";
const selectClass = `${inputClass} appearance-none`;
const textareaClass =
  "w-full rounded-md border border-[#DDE5E5] px-3 py-2 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] resize-y";
const labelClass = "block text-[13px] font-medium text-[#0A1F2E] mb-1";

export default function PortalPage() {
  const [submitted, setSubmitted] = useState(false);
  const [caseRef, setCaseRef] = useState("");
  const [slaDays, setSlaDays] = useState(14);
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  // Form state
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState<CaseCategory | "">("");
  const [priority, setPriority] = useState<CasePriority>("MEDIUM");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [productName, setProductName] = useState("");
  const [productSku, setProductSku] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [salesPerson, setSalesPerson] = useState("");

  function validate(): boolean {
    const errs: Record<string, boolean> = {};
    if (!brand) errs.brand = true;
    if (!category) errs.category = true;
    if (!customerName.trim()) errs.customerName = true;
    if (!customerPhone.trim()) errs.customerPhone = true;
    if (!customerEmail.trim()) errs.customerEmail = true;
    if (!customerAddress.trim()) errs.customerAddress = true;
    if (!productName.trim()) errs.productName = true;
    if (!issueDescription.trim()) errs.issueDescription = true;
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const caseNo = generateCaseNo();
    const now = new Date().toISOString();
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + SLA_DAYS[priority]);

    addCase({
      caseNo,
      status: "UNDER_VERIFICATION",
      priority,
      category: category as CaseCategory,
      brand,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim(),
      customerAddress: customerAddress.trim(),
      productName: productName.trim(),
      productSku: productSku.trim() || undefined,
      invoiceNo: invoiceNo.trim() || undefined,
      purchaseDate: purchaseDate || undefined,
      issueDescription: issueDescription.trim(),
      photoUrls: [],
      assignedTo: "",
      salesPerson: salesPerson.trim() || undefined,
      slaDeadline: deadline.toISOString().split("T")[0],
      createdAt: now,
      updatedAt: now,
      source: "PORTAL",
      timeline: [
        {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          caseId: "",
          timestamp: now,
          action: "Case submitted via Customer Portal",
          user: customerName.trim(),
        },
      ],
    });

    setCaseRef(caseNo);
    setSlaDays(SLA_DAYS[priority]);
    setSubmitted(true);
  }

  function resetForm() {
    setBrand("");
    setCategory("");
    setPriority("MEDIUM");
    setCustomerName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setCustomerAddress("");
    setProductName("");
    setProductSku("");
    setInvoiceNo("");
    setPurchaseDate("");
    setIssueDescription("");
    setSalesPerson("");
    setErrors({});
    setSubmitted(false);
    setCaseRef("");
  }

  const errBorder = (field: string) =>
    errors[field] ? "border-red-400 ring-1 ring-red-300" : "";

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F7F7]">
      {/* Header */}
      <header className="bg-[#0A1F2E] text-white">
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-gradient-to-br from-[#14B8A6] to-[#0F766E] flex items-center justify-center text-sm font-bold">
            H
          </div>
          <div>
            <div className="text-[16px] font-bold tracking-wider">HOUZS</div>
            <div className="text-[11px] text-gray-400">
              After-Sales Service Portal
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 py-8 px-4">
        {submitted ? (
          /* ── Success Screen ── */
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-xl shadow-sm border border-[#DDE5E5] p-10 text-center">
              <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-[#0A1F2E] mb-2">
                Case Submitted Successfully
              </h2>
              <p className="text-[14px] text-gray-500 mb-6">
                Your case reference number is:
              </p>
              <div className="inline-block bg-[#F4F7F7] border border-[#DDE5E5] rounded-lg px-6 py-3 mb-6">
                <span className="text-xl font-bold tracking-wider text-[#0F766E]">
                  {caseRef}
                </span>
              </div>
              <p className="text-[14px] text-gray-600 mb-8">
                Our team will review your case and contact you within{" "}
                <strong>{slaDays} business days</strong>.
              </p>
              <button
                onClick={resetForm}
                className="inline-flex items-center gap-2 bg-[#0F766E] hover:bg-[#0D6B63] text-white h-11 px-6 rounded-md font-semibold text-[14px] transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Submit Another Case
              </button>
            </div>
          </div>
        ) : (
          /* ── Form ── */
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
            <div className="bg-white rounded-xl shadow-sm border border-[#DDE5E5] p-6 sm:p-8">
              <h1 className="text-xl font-bold text-[#0A1F2E] mb-1">
                Submit a Service Request
              </h1>
              <p className="text-[13px] text-gray-500 mb-6">
                Please fill in the details below and our after-sales team will
                get back to you.
              </p>

              <div className="space-y-5">
                {/* ── Brand & Category ── */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>
                      Brand <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      className={`${selectClass} ${errBorder("brand")}`}
                    >
                      <option value="">Select brand</option>
                      {BRANDS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    {errors.brand && (
                      <p className="text-[11px] text-red-500 mt-0.5">
                        Please select a brand
                      </p>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>
                      Category <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={category}
                      onChange={(e) =>
                        setCategory(e.target.value as CaseCategory)
                      }
                      className={`${selectClass} ${errBorder("category")}`}
                    >
                      <option value="">Select category</option>
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    {errors.category && (
                      <p className="text-[11px] text-red-500 mt-0.5">
                        Please select a category
                      </p>
                    )}
                  </div>
                </div>

                {/* ── Priority ── */}
                <div>
                  <label className={labelClass}>Priority</label>
                  <select
                    value={priority}
                    onChange={(e) =>
                      setPriority(e.target.value as CasePriority)
                    }
                    className={selectClass}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* ── Contact Info ── */}
                <div className="border-t border-[#DDE5E5] pt-5">
                  <h3 className="text-[14px] font-semibold text-[#0A1F2E] mb-3">
                    Contact Information
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>
                        Your Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        placeholder="Full name"
                        className={`${inputClass} ${errBorder("customerName")}`}
                      />
                      {errors.customerName && (
                        <p className="text-[11px] text-red-500 mt-0.5">
                          Required
                        </p>
                      )}
                    </div>
                    <div>
                      <label className={labelClass}>
                        Phone Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value)}
                        placeholder="+60123456789"
                        className={`${inputClass} ${errBorder("customerPhone")}`}
                      />
                      {errors.customerPhone && (
                        <p className="text-[11px] text-red-500 mt-0.5">
                          Required
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-4">
                    <label className={labelClass}>
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder="you@example.com"
                      className={`${inputClass} ${errBorder("customerEmail")}`}
                    />
                    {errors.customerEmail && (
                      <p className="text-[11px] text-red-500 mt-0.5">
                        Required
                      </p>
                    )}
                  </div>
                  <div className="mt-4">
                    <label className={labelClass}>
                      Address <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={customerAddress}
                      onChange={(e) => setCustomerAddress(e.target.value)}
                      placeholder="Full delivery / home address"
                      rows={2}
                      className={`${textareaClass} ${errBorder("customerAddress")}`}
                    />
                    {errors.customerAddress && (
                      <p className="text-[11px] text-red-500 mt-0.5">
                        Required
                      </p>
                    )}
                  </div>
                </div>

                {/* ── Product Info ── */}
                <div className="border-t border-[#DDE5E5] pt-5">
                  <h3 className="text-[14px] font-semibold text-[#0A1F2E] mb-3">
                    Product Information
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>
                        Product Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={productName}
                        onChange={(e) => setProductName(e.target.value)}
                        placeholder="e.g. AKEMI Luxe Mattress Queen"
                        className={`${inputClass} ${errBorder("productName")}`}
                      />
                      {errors.productName && (
                        <p className="text-[11px] text-red-500 mt-0.5">
                          Required
                        </p>
                      )}
                    </div>
                    <div>
                      <label className={labelClass}>Product SKU</label>
                      <input
                        type="text"
                        value={productSku}
                        onChange={(e) => setProductSku(e.target.value)}
                        placeholder="Optional"
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className={labelClass}>Invoice Number</label>
                      <input
                        type="text"
                        value={invoiceNo}
                        onChange={(e) => setInvoiceNo(e.target.value)}
                        placeholder="Optional"
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Purchase Date</label>
                      <input
                        type="date"
                        value={purchaseDate}
                        onChange={(e) => setPurchaseDate(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>

                {/* ── Issue Details ── */}
                <div className="border-t border-[#DDE5E5] pt-5">
                  <h3 className="text-[14px] font-semibold text-[#0A1F2E] mb-3">
                    Issue Details
                  </h3>
                  <div>
                    <label className={labelClass}>
                      Describe Your Issue{" "}
                      <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={issueDescription}
                      onChange={(e) => setIssueDescription(e.target.value)}
                      placeholder="Please describe the issue in detail..."
                      rows={4}
                      className={`${textareaClass} ${errBorder("issueDescription")}`}
                    />
                    {errors.issueDescription && (
                      <p className="text-[11px] text-red-500 mt-0.5">
                        Required
                      </p>
                    )}
                  </div>
                  <div className="mt-4">
                    <label className={labelClass}>Sales Person Name</label>
                    <input
                      type="text"
                      value={salesPerson}
                      onChange={(e) => setSalesPerson(e.target.value)}
                      placeholder="Who sold you the product?"
                      className={inputClass}
                    />
                  </div>
                </div>

                {/* ── Submit ── */}
                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#0F766E] hover:bg-[#0D6B63] text-white h-11 px-8 rounded-md font-semibold text-[14px] transition-colors"
                  >
                    <Send className="h-4 w-4" />
                    Submit Case
                  </button>
                </div>
              </div>
            </div>
          </form>
        )}
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-[12px] text-gray-400">
        &copy; 2026 HOUZS Operations. For urgent matters, contact us at{" "}
        <a
          href="mailto:support@houzs.com"
          className="text-[#0F766E] hover:underline"
        >
          support@houzs.com
        </a>
      </footer>
    </div>
  );
}
