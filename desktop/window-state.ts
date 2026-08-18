export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayArea {
  workArea: Rectangle;
}

export function clampWindowBounds(
  requested: Rectangle | undefined,
  displays: DisplayArea[],
  fallback: Rectangle,
): Rectangle {
  if (!requested || displays.length === 0) return { ...fallback };
  const display =
    displays.find(({ workArea }) => intersects(requested, workArea)) ??
    displays[0];
  const workArea = display.workArea;
  const width = Math.min(
    Math.max(requested.width, 1024),
    Math.max(workArea.width, 1024),
  );
  const height = Math.min(
    Math.max(requested.height, 720),
    Math.max(workArea.height, 720),
  );
  return {
    x: Math.min(
      Math.max(requested.x, workArea.x),
      workArea.x + workArea.width - width,
    ),
    y: Math.min(
      Math.max(requested.y, workArea.y),
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

