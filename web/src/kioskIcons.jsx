import React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CircleCheckBig,
  CircleHelp,
  Delete,
  DoorOpen,
  LoaderCircle,
  PackageOpen,
  PackagePlus,
  Volume2,
  X,
} from 'lucide-react';

const DEFAULT_ICON_PROPS = {
  'aria-hidden': true,
  focusable: 'false',
  strokeWidth: 2.2,
};

export function KioskIcon({ icon: Icon, ...props }) {
  return <Icon {...DEFAULT_ICON_PROPS} {...props} />;
}

export const KioskIcons = {
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  check: CircleCheckBig,
  close: X,
  courier: PackagePlus,
  delete: Delete,
  door: DoorOpen,
  help: CircleHelp,
  loading: LoaderCircle,
  resident: PackageOpen,
  volume: Volume2,
};
