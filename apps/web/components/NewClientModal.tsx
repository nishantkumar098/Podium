"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import type { CityOptionDto } from "../lib/types";
import { FormField, Modal } from "./GovernanceUi";

export interface CreatedClient {
  id: string;
  name: string;
  cityId: string;
}

/** The fields this form can edit, as the Clients screen already holds them. */
export interface EditableClient {
  id: string;
  name: string;
  type: string;
  cityId?: string | null;
  gstin?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  since?: string | null;
}

const asDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "");

/**
 * Adds or edits a client. Shared by the Clients page and the invoice form's
 * "+ Add client".
 *
 * The billing address lives here rather than on some later "details" screen
 * because it is printed on every invoice this client is sent. It went
 * missing from the create form for a long time, and the consequence was not
 * a blank field in the UI — it was a GST invoice that said "Billing address
 * as per client records" where the customer's address should have been.
 */
export function NewClientModal({
  onClose,
  onCreated,
  initialName = "",
  initialCityId = "",
  client,
}: {
  onClose: () => void;
  onCreated?: (c: CreatedClient) => void;
  initialName?: string;
  initialCityId?: string;
  /** Pass a client to edit it; omit to add a new one. */
  client?: EditableClient;
}) {
  const qc = useQueryClient();
  const editing = !!client;
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const [f, setF] = useState({
    name: client?.name ?? initialName,
    type: client?.type ?? "INDIVIDUAL",
    cityId: client?.cityId ?? initialCityId,
    gstin: client?.gstin ?? "",
    address: client?.address ?? "",
    phone: client?.phone ?? "",
    email: client?.email ?? "",
    since: asDateInput(client?.since),
  });
  const gstin = f.gstin.trim().toUpperCase();

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        type: f.type,
        cityId: f.cityId,
        // Cleared fields are sent as null, not dropped: omitting them would
        // silently keep the old value when somebody deliberately blanks one.
        gstin: gstin || null,
        ...(gstin ? { gstStateCode: gstin.slice(0, 2) } : {}),
        address: f.address.trim() || null,
        phone: f.phone.trim() || null,
        email: f.email.trim() || null,
        ...(f.since ? { since: f.since } : {}),
      };
      return editing ? api.patch<CreatedClient>(`/clients/${client!.id}`, body) : api.post<CreatedClient>("/clients", body);
    },
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["clients"] });
      onCreated?.(c);
      onClose();
    },
  });

  const gstinOk = !gstin || /^\d{2}[A-Z0-9]{13}$/.test(gstin);
  const emailOk = !f.email.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  const ok = f.name.trim() && f.cityId && gstinOk && emailOk;

  return (
    <Modal
      title={editing ? `Edit ${client!.name}` : "New client"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Add client"}
          </button>
        </>
      }
    >
      <FormField label="Client name">
        <input className="inp" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Type">
          <select className="inp" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="INDIVIDUAL">Individual</option>
            <option value="CORPORATE">Corporate</option>
            <option value="BRAND">Brand</option>
          </select>
        </FormField>
        <FormField label="City">
          <select className="inp" value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}>
            <option value="">Choose a city</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <FormField label="Billing address (printed on their invoices)">
        <textarea
          className="inp"
          rows={2}
          value={f.address}
          onChange={(e) => setF({ ...f, address: e.target.value })}
          placeholder="Flat / building, street, area, city, PIN"
        />
      </FormField>

      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Phone">
          <input className="inp mono" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="9876543210" />
        </FormField>
        <FormField label="Email (invoices are sent here)">
          <input className="inp" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="accounts@client.com" />
        </FormField>
        <FormField label="GSTIN (for B2B invoices)">
          <input className="inp mono" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} placeholder="08ABCDE1234F1Z5" />
        </FormField>
        <FormField label="Client since">
          <input className="inp" type="date" value={f.since} onChange={(e) => setF({ ...f, since: e.target.value })} />
        </FormField>
      </div>

      {!gstinOk && <div className="small negative">A GSTIN is 15 characters and starts with the 2-digit state code.</div>}
      {!emailOk && <div className="small negative">That email address doesn&apos;t look right.</div>}
      <div className="small muted">The GSTIN&apos;s state code decides CGST+SGST vs IGST on this client&apos;s invoices.</div>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}
