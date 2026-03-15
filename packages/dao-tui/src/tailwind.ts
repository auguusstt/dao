import Yoga, { type Node as YogaNode } from 'yoga-layout';

export interface TailwindStyles {
  display?: 'flex' | 'none';
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'baseline';
  alignSelf?: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'baseline';
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | string;
  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  margin?: number;
  marginX?: number;
  marginY?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  aspectRatio?: number;
  position?: 'relative' | 'absolute';
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
}

export const t = {
  flex: { display: 'flex' } as TailwindStyles,
  hidden: { display: 'none' } as TailwindStyles,
  
  flexRow: { flexDirection: 'row' } as TailwindStyles,
  flexCol: { flexDirection: 'column' } as TailwindStyles,
  flexRowReverse: { flexDirection: 'row-reverse' } as TailwindStyles,
  flexColReverse: { flexDirection: 'column-reverse' } as TailwindStyles,
  
  justifyStart: { justifyContent: 'flex-start' } as TailwindStyles,
  justifyCenter: { justifyContent: 'center' } as TailwindStyles,
  justifyEnd: { justifyContent: 'flex-end' } as TailwindStyles,
  justifyBetween: { justifyContent: 'space-between' } as TailwindStyles,
  justifyAround: { justifyContent: 'space-around' } as TailwindStyles,
  justifyEvenly: { justifyContent: 'space-evenly' } as TailwindStyles,
  
  itemsStart: { alignItems: 'flex-start' } as TailwindStyles,
  itemsCenter: { alignItems: 'center' } as TailwindStyles,
  itemsEnd: { alignItems: 'flex-end' } as TailwindStyles,
  itemsStretch: { alignItems: 'stretch' } as TailwindStyles,
  itemsBaseline: { alignItems: 'baseline' } as TailwindStyles,
  
  flex1: { flexGrow: 1, flexShrink: 1, flexBasis: 0 } as TailwindStyles,
  grow: { flexGrow: 1 } as TailwindStyles,
  grow0: { flexGrow: 0 } as TailwindStyles,
  shrink: { flexShrink: 1 } as TailwindStyles,
  shrink0: { flexShrink: 0 } as TailwindStyles,

  selfAuto: { alignSelf: 'auto' } as TailwindStyles,
  selfStart: { alignSelf: 'flex-start' } as TailwindStyles,
  selfCenter: { alignSelf: 'center' } as TailwindStyles,
  selfEnd: { alignSelf: 'flex-end' } as TailwindStyles,
  selfStretch: { alignSelf: 'stretch' } as TailwindStyles,
  selfBaseline: { alignSelf: 'baseline' } as TailwindStyles,

  absolute: { position: 'absolute' } as TailwindStyles,
  relative: { position: 'relative' } as TailwindStyles,
};

export function applyStyles(node: YogaNode, styles: TailwindStyles | TailwindStyles[]) {
  const merged = Array.isArray(styles) ? Object.assign({}, ...styles) : styles;
  
  if (merged.display === 'flex') node.setDisplay(Yoga.DISPLAY_FLEX);
  if (merged.display === 'none') node.setDisplay(Yoga.DISPLAY_NONE);
  
  if (merged.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
  if (merged.flexDirection === 'column') node.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
  if (merged.flexDirection === 'row-reverse') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW_REVERSE);
  if (merged.flexDirection === 'column-reverse') node.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN_REVERSE);
  
  if (merged.justifyContent === 'flex-start') node.setJustifyContent(Yoga.JUSTIFY_FLEX_START);
  if (merged.justifyContent === 'center') node.setJustifyContent(Yoga.JUSTIFY_CENTER);
  if (merged.justifyContent === 'flex-end') node.setJustifyContent(Yoga.JUSTIFY_FLEX_END);
  if (merged.justifyContent === 'space-between') node.setJustifyContent(Yoga.JUSTIFY_SPACE_BETWEEN);
  if (merged.justifyContent === 'space-around') node.setJustifyContent(Yoga.JUSTIFY_SPACE_AROUND);
  if (merged.justifyContent === 'space-evenly') node.setJustifyContent(Yoga.JUSTIFY_SPACE_EVENLY);
  
  if (merged.alignItems === 'flex-start') node.setAlignItems(Yoga.ALIGN_FLEX_START);
  if (merged.alignItems === 'center') node.setAlignItems(Yoga.ALIGN_CENTER);
  if (merged.alignItems === 'flex-end') node.setAlignItems(Yoga.ALIGN_FLEX_END);
  if (merged.alignItems === 'stretch') node.setAlignItems(Yoga.ALIGN_STRETCH);
  if (merged.alignItems === 'baseline') node.setAlignItems(Yoga.ALIGN_BASELINE);
  
  if (merged.flexGrow !== undefined) node.setFlexGrow(merged.flexGrow);
  if (merged.flexShrink !== undefined) node.setFlexShrink(merged.flexShrink);
  
  if (typeof merged.width === 'number') node.setWidth(merged.width);
  if (typeof merged.height === 'number') node.setHeight(merged.height);
  
  // Basic padding/margin for demonstration
  if (merged.padding !== undefined) node.setPadding(Yoga.EDGE_ALL, merged.padding);
  if (merged.margin !== undefined) node.setMargin(Yoga.EDGE_ALL, merged.margin);
}
