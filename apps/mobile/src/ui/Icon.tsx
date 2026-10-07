import { useAppearance } from './Appearance';
import React from 'react';
import { Image } from 'react-native';
import homeImage from './assets/home.png';
import planImage from './assets/plan.png';
import yearImage from './assets/year.png';
import moreImage from './assets/more.png';
import leftImage from './assets/left.png';
import rightImage from './assets/right.png';
import closeImage from './assets/close.png';
import plusImage from './assets/plus.png';
import filterImage from './assets/filter.png';
import upImage from './assets/up.png';
import downImage from './assets/down.png';
import pinImage from './assets/pin.png';
import dotsImage from './assets/dots.png';
import repeatImage from './assets/repeat.png';
import cardImage from './assets/card.png';
import goalImage from './assets/goal.png';
import dataImage from './assets/data.png';
import catalogImage from './assets/catalog.png';
import checkImage from './assets/check.png';
import arrowUpImage from './assets/arrowUp.png';
import arrowDownImage from './assets/arrowDown.png';
import searchImage from './assets/search.png';
import calendarImage from './assets/calendar.png';
import moonImage from './assets/moon.png';
import sunImage from './assets/sun.png';
import settingsImage from './assets/settings.png';
import syncImage from './assets/sync.png';
import lockImage from './assets/lock.png';
import deviceImage from './assets/device.png';
import shieldImage from './assets/shield.png';
import slidersImage from './assets/sliders.png';
import trashImage from './assets/trash.png';
import editImage from './assets/edit.png';
import walletImage from './assets/wallet.png';
import uploadImage from './assets/upload.png';
import downloadImage from './assets/download.png';
import copyImage from './assets/copy.png';
import serverImage from './assets/server.png';
const sources = {
  calendar: calendarImage,
  moon: moonImage,
  sun: sunImage,
  settings: settingsImage,
  home: homeImage,
  plan: planImage,
  year: yearImage,
  more: moreImage,
  left: leftImage,
  right: rightImage,
  close: closeImage,
  plus: plusImage,
  filter: filterImage,
  up: upImage,
  down: downImage,
  pin: pinImage,
  dots: dotsImage,
  repeat: repeatImage,
  card: cardImage,
  goal: goalImage,
  data: dataImage,
  catalog: catalogImage,
  check: checkImage,
  arrowUp: arrowUpImage,
  arrowDown: arrowDownImage,
  search: searchImage,
  sync: syncImage,
  lock: lockImage,
  device: deviceImage,
  shield: shieldImage,
  sliders: slidersImage,
  trash: trashImage,
  edit: editImage,
  wallet: walletImage,
  upload: uploadImage,
  download: downloadImage,
  copy: copyImage,
  server: serverImage,
};
export type IconName = keyof typeof sources;
export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useAppearance();
  return (
    <Image
      accessible={false}
      source={sources[name]}
      style={{ width: size, height: size, tintColor: color ?? colors.soft }}
    />
  );
}
