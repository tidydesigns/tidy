"use client";

import { memo } from "react";
import { ComponentPropertiesInspector } from "./component-properties-inspector";
import { ExportControls } from "./export-controls";
import { HandoffInspector } from "./handoff-inspector";
import { QuietInspector, InspectorDisclosure } from "./inspector-presentation";
import { SelectionColorsInspector } from "./inspector/selection-colors-inspector";
import { useRenderedSelection } from "./inspector/use-rendered-selection";
import { selectionFeatures, selectionLayout } from "./inspector/selection";
import type { SelectionInspectorProps } from "./inspector/types";
import { IdentitySection } from "./inspector/identity-section";
import { PositionSection } from "./inspector/position-section";
import { TypographySection } from "./inspector/typography-section";
import { ImageSection } from "./inspector/image-section";
import { VectorSection } from "./inspector/vector-section";
import { AppearanceSection } from "./inspector/appearance-section";
import { LayoutSection } from "./inspector/layout-section";
import { AdvancedSection } from "./inspector/advanced-section";

export const SelectionInspector = memo(function SelectionInspector({
  selected: sourceSelection,
  nodesById,
  mode = "design",
  readOnly = false,
  document,
  viewport,
  onPatch,
  onDocument,
  onGoToMaster,
  onExport,
  exportPending = false,
  exportWarnings,
  ...actions
}: SelectionInspectorProps) {
  const selected = useRenderedSelection(sourceSelection, document, viewport, nodesById);
  const inspect = readOnly || mode === "inspect";
  const { multi, text, image, vector, hasVector, containers } = selectionFeatures(selected);
  const identity = (
    <IdentitySection
      selected={selected}
      document={document}
      readOnly={readOnly}
      inspect={inspect}
      text={text}
      image={image}
      vector={vector}
      onPatch={onPatch}
      onDocument={onDocument}
      onGoToMaster={onGoToMaster}
    />
  );
  const exportOptions = (
    <ExportControls
      selected={sourceSelection}
      onExport={onExport}
      pending={exportPending}
      warnings={exportWarnings}
    />
  );
  if (inspect)
    return (
      <div>
        {identity}
        <HandoffInspector selected={sourceSelection} document={document} viewport={viewport} />
        {exportOptions}
      </div>
    );
  const layout = selectionLayout(selected, document);
  const node = selected[0];
  return (
    <QuietInspector value={true}>
      <div className="quiet-inspector">
        {identity}
        <fieldset disabled={readOnly} className="min-w-0">
          {!multi && (
            <ComponentPropertiesInspector
              node={node}
              mode="properties"
              document={document}
              onDocument={onDocument}
            />
          )}
          <PositionSection
            text={text}
            {...layout}
            selected={selected}
            document={document}
            onPatch={onPatch}
            cropping={actions.cropping ?? false}
            onScale={actions.onScale}
            onAlign={actions.onAlign}
            onDistribute={actions.onDistribute}
          />
          {text && <TypographySection selected={selected} onPatch={onPatch} viewport={viewport} />}
          {image && (
            <ImageSection
              selected={selected}
              onPatch={onPatch}
              onReplaceImage={actions.onReplaceImage}
              onEditImage={actions.onEditImage}
              onCropImage={actions.onCropImage}
              onFitImageBounds={actions.onFitImageBounds}
              cropping={actions.cropping ?? false}
            />
          )}
          <VectorSection
            vector={vector}
            selected={selected}
            document={document}
            onPatch={onPatch}
            onDocument={onDocument}
            onEditVector={actions.onEditVector}
            editingVector={actions.editingVector ?? false}
            readOnly={readOnly}
          />
          <AppearanceSection
            text={text}
            vector={vector}
            hasVector={hasVector}
            selected={selected}
            document={document}
            onPatch={onPatch}
            onUploadFill={actions.onUploadFill}
            onEditImage={actions.onEditImage}
            editingGradientId={actions.editingGradientId}
            onGradientEdit={actions.onGradientEdit}
            viewport={viewport}
          />
          <SelectionColorsInspector
            key={sourceSelection.map((node) => node.id).join("|")}
            selected={sourceSelection}
            document={document}
            onDocument={onDocument}
          />
          <LayoutSection
            containers={containers}
            {...layout}
            selected={selected}
            document={document}
            onPatch={onPatch}
            onDocument={onDocument}
            viewport={viewport}
            onGroup={actions.onGroup}
          />
          <AdvancedSection
            selected={selected}
            sourceSelection={sourceSelection}
            document={document}
            onPatch={onPatch}
            onDocument={onDocument}
          />
        </fieldset>
        <InspectorDisclosure title="Export">{exportOptions}</InspectorDisclosure>
      </div>
    </QuietInspector>
  );
});
