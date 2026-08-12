import { memo } from 'react';

import { Icon, IconProps } from './Icon';
import { ArrowRightOutlined } from '../../shared/icons/FontAwesomeIcons';

export type ArrowProps = {
  /**
   * @default 'right'
   */
  direction?: Direction;
} & IconProps;

type Direction = 'left' | 'right' | 'top' | 'bottom';

export const Arrow = memo(function Arrow(props: ArrowProps) {
  const { direction = 'bottom', ...iconProps } = props;
  const rotate = rotationByDirection[direction];

  return (
    <Icon {...iconProps}>
      <ArrowRightOutlined style={{ transform: `rotate(${rotate}deg)` }} />
    </Icon>
  );
});

const rotationByDirection: Record<Direction, number> = {
  right: 0,
  bottom: 90,
  left: 180,
  top: -90,
};
