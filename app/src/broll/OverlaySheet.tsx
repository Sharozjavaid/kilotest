import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { TEMPLATES, type BrollAssetView, type Overlay, type TemplateId } from '@kilo/edl';
import { Card, Header, Icon, PillButton, Row, Screen, SectionLabel, Text, Thumb, Toggle, color, radius, typeStyle } from '@/ui';
import { assetTitle, durationLimits, fmtSec, type OverlayContent, type OverlayProblem, type SpokenLine } from './overlays';
import { TEMPLATE_FIELDS, charsLeft, formFromProps, limitText, prefillProps, propsFromForm, type FormValues, type TemplateField } from './templateForms';
import { GraphicThumb } from './GraphicThumb';

type Choice = { type: 'asset'; id: string } | { type: 'template'; id: TemplateId };

export interface OverlaySheetProps {
  visible: boolean;
  line: SpokenLine | null;
  /** The overlay being swapped; null when adding to an empty line. */
  overlay: Overlay | null;
  assets: readonly BrollAssetView[];
  themeId: string;
  /** Upload progress per asset id (0..1) for assets still uploading from this phone. */
  uploads: ReadonlyMap<string, number>;
  /** Applies the choice. Returns a problem to show, or null when it was applied. */
  onApply: (content: OverlayContent, durationSec: number) => OverlayProblem | null;
  onRemove: () => void;
  onAddClips: () => void;
  onClose: () => void;
  /** The openings of the video, and whether each leaves this (base) overlay out. Empty: none to choose. */
  versions?: readonly { id: string; label: string; hidden: boolean }[];
  /** Show or hide this overlay in one opening. */
  onSetHidden?: (variantId: string, hidden: boolean) => void;
}

/** Swap or Add: the video's B-roll and the five motion graphic templates with editable text. */
export function OverlaySheet({ visible, line, overlay, assets, themeId, uploads, onApply, onRemove, onAddClips, onClose, versions = [], onSetHidden }: OverlaySheetProps) {
  const lineText = line?.segment.text ?? '';
  const [choice, setChoice] = useState<Choice | null>(null);
  const [forms, setForms] = useState<Partial<Record<TemplateId, FormValues>>>({});
  const [duration, setDuration] = useState(2);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  // Reset whenever the sheet opens on a line.
  useEffect(() => {
    if (!visible) return;
    setErrors({});
    setProblem(null);
    const initialForms: Partial<Record<TemplateId, FormValues>> = {};
    for (const t of TEMPLATES) initialForms[t.id] = formFromProps(t.id, prefillProps(t.id, lineText));
    if (overlay?.type === 'graphic') {
      initialForms[overlay.template] = formFromProps(overlay.template, overlay.props);
      setChoice({ type: 'template', id: overlay.template });
      setDuration(overlay.durationSec);
    } else if (overlay?.type === 'broll') {
      setChoice({ type: 'asset', id: overlay.assetId });
      setDuration(overlay.durationSec);
    } else {
      const firstReady = assets.find((a) => a.status === 'ready');
      const c: Choice = firstReady ? { type: 'asset', id: firstReady.id } : { type: 'template', id: 'bold-title' };
      setChoice(c);
      setDuration(limitsFor(c, assets).default);
    }
    setForms(initialForms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, line?.segment.id, overlay?.id]);

  const pick = (c: Choice) => {
    setChoice(c);
    setErrors({});
    setProblem(null);
    const current = overlay && sameContent(overlay, c);
    setDuration(current ? overlay!.durationSec : limitsFor(c, assets).default);
  };

  const limits = choice ? limitsFor(choice, assets) : null;
  const apply = () => {
    if (!choice) return;
    let content: OverlayContent;
    if (choice.type === 'asset') {
      const asset = assets.find((a) => a.id === choice.id);
      if (!asset) return;
      content = { type: 'broll', asset };
    } else {
      const r = propsFromForm(choice.id, forms[choice.id] ?? {});
      if (!r.ok) {
        setErrors(r.errors);
        return;
      }
      content = { type: 'graphic', template: choice.id, props: r.props };
    }
    const p = onApply(content, duration);
    if (p) setProblem(p.message);
    else onClose();
  };

  const setField = (template: TemplateId, key: string, value: string | string[]) => {
    setForms((f) => ({ ...f, [template]: { ...(f[template] ?? {}), [key]: value } }));
    setErrors((e) => {
      const { [key]: _, ...rest } = e;
      return rest;
    });
  };

  const selectedTemplate = choice?.type === 'template' ? choice.id : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen
        gap={14}
        footer={
          <>
            {problem ? (
              <Text variant="secondary" tone="cut" center accessibilityLiveRegion="polite" testID="overlay-problem">
                {problem}
              </Text>
            ) : null}
            <PillButton label={overlay ? 'Use this' : 'Add to this line'} onPress={apply} disabled={!choice} testID="overlay-apply" />
            {overlay ? <PillButton variant="text" destructive label="Remove from this line" onPress={onRemove} testID="overlay-remove" /> : null}
          </>
        }
      >
        <Header title={overlay ? 'Swap' : 'Add to this line'} onBack={onClose} />
        {line ? (
          <Text variant="body" style={{ lineHeight: 20 }}>
            “{lineText}”
          </Text>
        ) : null}

        {overlay && versions.length && onSetHidden ? (
          <View style={{ gap: 6 }}>
            <SectionLabel>Shown in</SectionLabel>
            <Card padding={0} paddingHorizontal={16}>
              {versions.map((v, i) => (
                <Row
                  key={v.id}
                  divider={i > 0}
                  minHeight={52}
                  title={v.label}
                  subtitle={v.hidden ? 'Left out of this opening' : undefined}
                  right={<Toggle value={!v.hidden} onValueChange={(on) => onSetHidden(v.id, !on)} accessibilityLabel={`Show in ${v.label}`} testID={`shown-in-${v.id}`} />}
                />
              ))}
            </Card>
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <SectionLabel>Your clips</SectionLabel>
          <Card padding={0} paddingHorizontal={16}>
            {assets.length === 0 ? (
              <Row title="No clips for this video yet" subtitle="Add product shots or cutaways and Kilo can place them." right={<PillButton variant="secondary" height={44} label="Add clips" onPress={onAddClips} />} />
            ) : (
              assets.map((a, i) => {
                const ready = a.status === 'ready';
                const selected = choice?.type === 'asset' && choice.id === a.id;
                return (
                  <Row
                    key={a.id}
                    divider={i > 0}
                    left={<Thumb uri={a.thumbnailUrl} width={36} height={48} />}
                    title={assetTitle(a)}
                    subtitle={assetStatus(a, uploads.get(a.id))}
                    onPress={ready ? () => pick({ type: 'asset', id: a.id }) : undefined}
                    accessibilityLabel={`${assetTitle(a)}, ${assetStatus(a, uploads.get(a.id))}${selected ? ', selected' : ''}`}
                    style={!ready ? { opacity: 0.55 } : undefined}
                    right={selected ? <Icon name="check" size={20} color={color.accent} strokeWidth={2.4} /> : null}
                    testID={`asset-${a.id}`}
                  />
                );
              })
            )}
          </Card>
        </View>

        <View style={{ gap: 6 }}>
          <SectionLabel>Motion graphics</SectionLabel>
          <Card padding={0} paddingHorizontal={16}>
            {TEMPLATES.map((t, i) => {
              const selected = selectedTemplate === t.id;
              const preview = propsFromForm(t.id, forms[t.id] ?? {});
              return (
                <View key={t.id} style={i > 0 ? styles.divider : undefined}>
                  <Row
                    left={<GraphicThumb template={t.id} props={preview.ok ? preview.props : t.example} themeId={themeId} width={36} height={48} />}
                    title={t.name}
                    subtitle={`${fmtSec(t.minDurationSec)} to ${fmtSec(t.maxDurationSec)}`}
                    onPress={() => pick({ type: 'template', id: t.id })}
                    accessibilityLabel={`${t.name}${selected ? ', selected' : ''}`}
                    right={selected ? <Icon name="check" size={20} color={color.accent} strokeWidth={2.4} /> : null}
                    testID={`template-${t.id}`}
                  />
                  {selected ? (
                    <View style={styles.form}>
                      {TEMPLATE_FIELDS[t.id].map((f) => (
                        <FieldEditor
                          key={f.key}
                          field={f}
                          value={(forms[t.id] ?? {})[f.key] ?? (f.kind === 'list' ? [] : '')}
                          error={errors[f.key]}
                          onChange={(v) => setField(t.id, f.key, v)}
                        />
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>

        {limits ? (
          <Card padding={0} paddingHorizontal={16} flat>
            <Row
              minHeight={60}
              title="Time on screen"
              subtitle={`${fmtSec(limits.min)} to ${fmtSec(limits.max)}${choice?.type === 'asset' && assets.find((a) => a.id === choice.id)?.kind === 'video' ? ', the clip length' : ''}`}
              right={<DurationStepper value={duration} min={limits.min} max={limits.max} onChange={setDuration} />}
            />
          </Card>
        ) : null}
      </Screen>
    </Modal>
  );
}

function sameContent(o: Overlay, c: Choice): boolean {
  return (o.type === 'broll' && c.type === 'asset' && o.assetId === c.id) || (o.type === 'graphic' && c.type === 'template' && o.template === c.id);
}

function limitsFor(c: Choice, assets: readonly BrollAssetView[]) {
  if (c.type === 'template') return durationLimits({ type: 'graphic', template: c.id, props: {} });
  const asset = assets.find((a) => a.id === c.id);
  return asset ? durationLimits({ type: 'broll', asset }) : { min: 1, max: 6, default: 2.4 };
}

/** "Ready · 4 seconds", "Photo · ready", "Uploading 40%", "Processing", "Couldn't process". */
export function assetStatus(a: BrollAssetView, uploadFraction?: number): string {
  switch (a.status) {
    case 'uploading':
      return uploadFraction !== undefined ? `Uploading ${Math.round(uploadFraction * 100)}%` : 'Waiting to upload';
    case 'processing':
      return 'Processing';
    case 'failed':
      return "Couldn't process this file";
    case 'ready':
      return a.kind === 'image' ? 'Photo · slow pan' : a.durationSec ? `Clip · ${fmtSec(a.durationSec)}` : 'Clip';
  }
}

function FieldEditor({ field, value, error, onChange }: { field: TemplateField; value: string | string[]; error?: string; onChange: (v: string | string[]) => void }) {
  if (field.kind === 'list') {
    const items = Array.isArray(value) ? value : [];
    return (
      <View style={{ gap: 6 }}>
        <View style={styles.fieldHead}>
          <Text variant="secondary" weight={500}>
            {field.label}
          </Text>
          <Text variant="label" tone="muted">
            {limitText(field)}
          </Text>
        </View>
        {items.map((item, i) => (
          <View key={i} style={styles.listRow}>
            <Text variant="secondary" tone="muted" style={{ width: 16 }}>
              {i + 1}
            </Text>
            <TextInput
              value={item}
              onChangeText={(t) => onChange(items.map((x, k) => (k === i ? t : x)))}
              maxLength={field.maxLength + 10}
              accessibilityLabel={`${field.label} ${i + 1}`}
              style={[styles.input, { flex: 1 }, charsLeft(field, item) < 0 && styles.inputError]}
              placeholderTextColor={color.muted}
              testID={`field-${field.key}-${i}`}
            />
            <Pressable onPress={() => onChange(items.filter((_, k) => k !== i))} accessibilityRole="button" accessibilityLabel={`Remove ${field.label.toLowerCase()} ${i + 1}`} style={styles.iconHit}>
              <Icon name="close" size={16} color={color.muted} />
            </Pressable>
          </View>
        ))}
        {items.length < (field.maxItems ?? 5) ? (
          <PillButton variant="text" icon="plus" label={`Add ${field.label === 'Words' ? 'a word' : 'an item'}`} onPress={() => onChange([...items, ''])} style={{ alignSelf: 'flex-start' }} />
        ) : null}
        {error ? (
          <Text variant="label" tone="cut">
            {error}
          </Text>
        ) : null}
      </View>
    );
  }
  const text = typeof value === 'string' ? value : '';
  const left = charsLeft(field, text);
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.fieldHead}>
        <Text variant="secondary" weight={500}>
          {field.label}
        </Text>
        <Text variant="label" tone={left < 0 ? 'cut' : 'muted'}>
          {field.required ? '' : 'Optional · '}
          {text.trim().length}/{field.maxLength}
        </Text>
      </View>
      <TextInput
        value={text}
        onChangeText={onChange}
        maxLength={field.maxLength + 10}
        accessibilityLabel={`${field.label}, ${limitText(field)}`}
        style={[styles.input, (left < 0 || !!error) && styles.inputError]}
        placeholderTextColor={color.muted}
        testID={`field-${field.key}`}
      />
      {error ? (
        <Text variant="label" tone="cut">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** − 1.6 s + in steps of 0.2 s. */
export function DurationStepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const step = (d: number) => onChange(Math.round(Math.min(max, Math.max(min, value + d)) * 10) / 10);
  return (
    <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel="Time on screen" accessibilityValue={{ text: fmtSec(value) }}>
      <StepButton glyph="−" label="Shorter" disabled={value <= min + 1e-3} onPress={() => step(-0.2)} />
      <Text variant="body" weight={600} center style={{ minWidth: 42 }}>
        {value.toFixed(1)}s
      </Text>
      <StepButton glyph="+" label="Longer" disabled={value >= max - 1e-3} onPress={() => step(0.2)} />
    </View>
  );
}

function StepButton({ glyph, label, disabled, onPress }: { glyph: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => [styles.stepButton, (disabled || pressed) && { opacity: disabled ? 0.4 : 0.7 }]}>
      <Text variant="body" style={{ fontSize: 20, lineHeight: 22 }}>
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  divider: { borderTopWidth: 1, borderTopColor: color.hairline },
  form: { gap: 12, paddingBottom: 14 },
  fieldHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: {
    ...typeStyle('body'),
    color: color.ink,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.outline,
    backgroundColor: color.white,
    paddingHorizontal: 12,
  },
  inputError: { borderColor: color.cut },
  iconHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: color.outline,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
