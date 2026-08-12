import React, { ComponentType, CSSProperties, forwardRef } from 'react';
import { IconType } from 'react-icons';
import {
  FaArrowDown,
  FaArrowRight,
  FaArrowUp,
  FaArrowsRotate,
  FaBars,
  FaBolt,
  FaCalendar,
  FaCaretDown,
  FaChartArea,
  FaChartBar,
  FaChartLine,
  FaChartPie,
  FaCheck,
  FaChevronDown,
  FaChevronLeft,
  FaChevronRight,
  FaCircleCheck,
  FaCircleInfo,
  FaCirclePlay,
  FaCircleQuestion,
  FaCircleStop,
  FaCircleXmark,
  FaCloud,
  FaCode,
  FaCodepen,
  FaCopy,
  FaCube,
  FaDiagramProject,
  FaEllipsis,
  FaEye,
  FaFile,
  FaFilter,
  FaFolder,
  FaFolderOpen,
  FaGrip,
  FaHashtag,
  FaKey,
  FaLayerGroup,
  FaLock,
  FaMagnifyingGlass,
  FaPen,
  FaPlus,
  FaQuestion,
  FaRegCircleCheck,
  FaRegCirclePlay,
  FaRegCircleQuestion,
  FaRegStar,
  FaRulerCombined,
  FaSlack,
  FaSpinner,
  FaSquareCaretRight,
  FaStar,
  FaTable,
  FaTableList,
  FaToggleOn,
  FaTriangleExclamation,
  FaUpload,
  FaXmark,
} from 'react-icons/fa6';

type CompatIconProps = React.HTMLAttributes<HTMLSpanElement> & {
  component?: ComponentType<any>;
  spin?: boolean;
  rotate?: number;
  twoToneColor?: string;
  color?: string;
  size?: string | number;
  styles?: CSSProperties;
};

function resolveColor(color?: string) {
  if (color && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) {
    return color;
  }

  if (color && /^#[a-z][a-z0-9-]*$/i.test(color)) {
    return `var(--${color.slice(1)}-color)`;
  }

  return color;
}

function makeIcon(Source: IconType) {
  return forwardRef<HTMLSpanElement, CompatIconProps>(function FontAwesomeIcon(
    { className = '', color, size, spin, rotate, style, styles, ...props },
    ref
  ) {
    const iconStyle: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      lineHeight: 1,
      color: resolveColor(color),
      fontSize: size,
      ...styles,
      ...style,
      ...(rotate ? { transform: `rotate(${rotate}deg)` } : {}),
    };

    return (
      <span
        {...props}
        ref={ref}
        className={`anticon font-awesome-icon${spin ? ' anticon-spin' : ''}${className ? ` ${className}` : ''}`}
        style={iconStyle}
      >
        <Source aria-hidden focusable={false} />
      </span>
    );
  });
}

const CustomIcon = forwardRef<HTMLSpanElement, CompatIconProps>(function CustomIcon(
  { component: Component, className = '', spin, style, ...props },
  ref
) {
  return (
    <span
      {...props}
      ref={ref}
      className={`anticon${spin ? ' anticon-spin' : ''}${className ? ` ${className}` : ''}`}
      style={{ display: 'inline-flex', lineHeight: 1, ...style }}
    >
      {Component ? <Component /> : null}
    </span>
  );
});

export default CustomIcon;

export const AreaChartOutlined = makeIcon(FaChartArea);
export const ApartmentOutlined = makeIcon(FaDiagramProject);
export const ArrowDownOutlined = makeIcon(FaArrowDown);
export const ArrowRightOutlined = makeIcon(FaArrowRight);
export const ArrowUpOutlined = makeIcon(FaArrowUp);
export const BarChartOutlined = makeIcon(FaChartBar);
export const CheckCircleFilled = makeIcon(FaCircleCheck);
export const CheckCircleOutlined = makeIcon(FaRegCircleCheck);
export const CheckOutlined = makeIcon(FaCheck);
export const ClearOutlined = makeIcon(FaXmark);
export const CloseOutlined = makeIcon(FaXmark);
export const CloseCircleFilled = makeIcon(FaCircleXmark);
export const CloudFilled = makeIcon(FaCloud);
export const CodeOutlined = makeIcon(FaCode);
export const CodeSandboxOutlined = makeIcon(FaCodepen);
export const CopyOutlined = makeIcon(FaCopy);
export const DownOutlined = makeIcon(FaChevronDown);
export const DragOutlined = makeIcon(FaGrip);
export const EditOutlined = makeIcon(FaPen);
export const FileFilled = makeIcon(FaFile);
export const FilterFilled = makeIcon(FaFilter);
export const FilterOutlined = makeIcon(FaFilter);
export const FolderFilled = makeIcon(FaFolder);
export const FolderOpenFilled = makeIcon(FaFolderOpen);
export const InfoCircleOutlined = makeIcon(FaCircleInfo);
export const InfoCircleFilled = makeIcon(FaCircleInfo);
export const LeftOutlined = makeIcon(FaChevronLeft);
export const LineChartOutlined = makeIcon(FaChartLine);
export const LoadingOutlined = makeIcon(FaSpinner);
export const LockOutlined = makeIcon(FaLock);
export const MenuOutlined = makeIcon(FaBars);
export const MoreOutlined = makeIcon(FaEllipsis);
export const PieChartOutlined = makeIcon(FaChartPie);
export const PlayCircleOutlined = makeIcon(FaRegCirclePlay);
export const PlaySquareOutlined = makeIcon(FaSquareCaretRight);
export const PlusOutlined = makeIcon(FaPlus);
export const QuestionCircleFilled = makeIcon(FaCircleQuestion);
export const QuestionCircleOutlined = makeIcon(FaRegCircleQuestion);
export const QuestionOutlined = makeIcon(FaQuestion);
export const ReloadOutlined = makeIcon(FaArrowsRotate);
export const RightOutlined = makeIcon(FaChevronRight);
export const SearchOutlined = makeIcon(FaMagnifyingGlass);
export const SlackOutlined = makeIcon(FaSlack);
export const StarFilled = makeIcon(FaStar);
export const StarOutlined = makeIcon(FaRegStar);
export const SyncOutlined = makeIcon(FaArrowsRotate);
export const TableOutlined = makeIcon(FaTable);
export const TableListOutlined = makeIcon(FaTableList);
export const ThunderboltFilled = makeIcon(FaBolt);
export const ThunderboltOutlined = makeIcon(FaBolt);
export const UploadOutlined = makeIcon(FaUpload);
export const WarningFilled = makeIcon(FaTriangleExclamation);

// Equivalentes usados anteriormente pelo UI Kit.
export const CalendarIcon = makeIcon(FaCalendar);
export const CaretDownIcon = makeIcon(FaCaretDown);
export const ClearIcon = makeIcon(FaXmark);
export const CloseIcon = makeIcon(FaXmark);
export const CopyIcon = makeIcon(FaCopy);
export const CubeIcon = makeIcon(FaCube);
export const DownIcon = makeIcon(FaChevronDown);
export const FilterIcon = makeIcon(FaFilter);
export const FolderFilledIcon = makeIcon(FaFolder);
export const FolderOpenFilledIcon = makeIcon(FaFolderOpen);
export const HierarchyIcon = makeIcon(FaLayerGroup);
export const InfoCircleIcon = makeIcon(FaCircleInfo);
export const LoadingIcon = makeIcon(FaSpinner);
export const LockIcon = makeIcon(FaLock);
export const MoreIcon = makeIcon(FaEllipsis);
export const NumberIcon = makeIcon(FaHashtag);
export const PlusIcon = makeIcon(FaPlus);
export const PrimaryKeyFontAwesomeIcon = makeIcon(FaKey);
export const RulerCombinedIcon = makeIcon(FaRulerCombined);
export const StopFontAwesomeIcon = makeIcon(FaCircleStop);
export const StringIcon = makeIcon(FaCode);
export const ThunderboltIcon = makeIcon(FaBolt);
export const TimeIcon = makeIcon(FaCalendar);
export const BooleanIcon = makeIcon(FaToggleOn);
export const UpIcon = makeIcon(FaArrowUp);
export const ViewIcon = makeIcon(FaEye);
