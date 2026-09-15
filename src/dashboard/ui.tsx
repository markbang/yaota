import { Button, Chip, Input, Label, ListBox, NumberField, Select, TextField, Tooltip, toast } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

export function IconButton({ label, children, onPress, disabled = false }: { label: string; children: ReactNode; onPress: () => void; disabled?: boolean }) {
  return <Tooltip delay={350}><Button isIconOnly size="sm" variant="ghost" aria-label={label} onPress={onPress} isDisabled={disabled}>{children}</Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <IconButton label={copied ? "Copied" : label} onPress={() => {
    if (!navigator.clipboard) { toast.danger("Clipboard is unavailable in this browser"); return; }
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => toast.danger("Unable to copy to clipboard"));
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>;
}
export function Choice({ label, value, onChange, options, name, hiddenLabel = false, disabled = false, required = false, className = "" }: {
  label: string; value: string; onChange: (value: string) => void; options: { id: string; label: string }[];
  name?: string; hiddenLabel?: boolean; disabled?: boolean; required?: boolean; className?: string;
}) {
  return <Select name={name} aria-label={hiddenLabel ? label : undefined} className={className} value={value || null} onChange={key => onChange(String(key ?? ""))} isDisabled={disabled} isRequired={required} placeholder={`Select ${label.toLowerCase()}`}>
    {!hiddenLabel && <Label>{label}</Label>}
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}><span className="option-label">{option.label}</span><ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}
export function Field({ name, label, value = "", required = false, readOnly = false, type = "text", autoFocus = false, pattern }: {
  name: string; label: string; value?: string; required?: boolean; readOnly?: boolean; type?: "text" | "password"; autoFocus?: boolean; pattern?: string;
}) {
  return <TextField name={name} defaultValue={value} isRequired={required} isReadOnly={readOnly} type={type} autoFocus={autoFocus} pattern={pattern}><Label>{label}</Label><Input autoComplete="off" /></TextField>;
}
export function Percentage({ value, onChange, label = "Rollout percentage", name = "percentage", min = 0 }: { value: number; onChange: (value: number) => void; label?: string; name?: string; min?: number }) {
  return <NumberField name={name} minValue={min} maxValue={100} step={1} value={value} onChange={onChange} isRequired><Label>{label}</Label><NumberField.Group><NumberField.DecrementButton /><NumberField.Input /><NumberField.IncrementButton /></NumberField.Group></NumberField>;
}
export function Status({ status }: { status: string }) {
  const color = status === "Live" ? "success" : status === "Staged" ? "warning" : status === "Embedded" ? "accent" : "default";
  return <Chip color={color} size="sm" variant="soft"><span className="status-dot" />{status}</Chip>;
}
export const formatDate = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function Empty({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><p>{title}</p>{action}</div>;
}
