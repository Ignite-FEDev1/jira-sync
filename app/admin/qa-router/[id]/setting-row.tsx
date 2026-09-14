/**
 * 설정 탭의 줄과 묶음.
 *
 * 읽기(settings/page.tsx)와 편집(settings-form.tsx)이 같은 묶음, 같은 순서,
 * 같은 라벨 폭을
 * 쓰게 하려고 한 곳에 둔다. 따로 두면 한쪽만 고쳐져 두 화면이 어긋난다.
 *
 * 라우트 파일은 컴포넌트를 export 할 수 없어서 별도 파일로 둔다.
 */

/**
 * 라벨 열 폭. 읽기와 편집이 같은 값을 써야 값 시작점이 일치한다.
 *
 * 남은 라벨 중 가장 긴 것이 "자동 재배정"(6자)이라 92px 면 한 줄에 들어간다.
 * 전에는 132px 였는데 그 폭을 요구한 라벨("한꺼번에 알릴 개수")을 화면에서
 * 빼면서 "이름"·"대상 필터" 같은 짧은 라벨 뒤에 40px 넘는 빈칸이 남았다.
 */
const LABEL_W = 'w-[92px]';

/** 줄 사이 간격. 묶음 안이든 밖이든 같아야 편집 전환 때 줄이 밀리지 않는다. */
const ROW_GAP = 'flex flex-col gap-2';

/**
 * 묶음에 들어가지 않는 줄들.
 *
 * 여섯 줄뿐인 화면에서 네 덩어리로 나누면 소제목과 구분선이 값보다 넓은
 * 자리를 차지한다. 대부분의 줄은 소제목 없이 한 흐름으로 두고, 성격이
 * 정말 다른 줄만 SettingGroup 으로 떼어낸다.
 */
export function SettingRows({ children }: { children: React.ReactNode }) {
  return <div className={ROW_GAP}>{children}</div>;
}

/**
 * 설정 묶음.
 *
 * 구분선을 소제목 아래가 아니라 묶음 위에 둔다 — 선이 하는 일은 소제목을
 * 밑줄 치는 게 아니라 "위쪽과는 성격이 다르다"고 말하는 것이다.
 * 소제목은 uppercase·tracking 을 쓰지 않는다. 한글에 uppercase 는 효과가 없고
 * 자간만 벌어져 오히려 흐려진다. 대신 색을 foreground 로 올려 라벨(muted)과
 * 굵기·색으로 구분한다.
 */
export function SettingGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-2 text-xs font-semibold text-foreground">{title}</div>
      <div className={ROW_GAP}>{children}</div>
    </div>
  );
}

/**
 * 라벨 폭을 고정한 2열.
 *
 * 값을 오른쪽 끝으로 밀지 않는다 — 양끝 정렬은 한 줄을 읽을 때마다 눈이
 * 좌우로 왕복하게 만든다. 값이 라벨 옆에 서면 시선이 한 줄 안에서만 움직이고,
 * 여러 줄의 값이 같은 열에서 시작해 훑기도 쉽다.
 */
export function SettingRow({
  label,
  htmlFor,
  align,
  children,
}: {
  label: string;
  /** 편집 폼에서 입력과 라벨을 연결한다. 없으면 dt 로 렌더한다. */
  htmlFor?: string;
  /**
   * 입력이 들어가는 줄은 라벨을 살짝 내려 첫 줄에 맞춘다.
   *
   * 'center' 는 스위치처럼 글자가 아닌 컨트롤이 값일 때 쓴다. 스위치는
   * overflow 가 hidden 이라 베이스라인이 상자 밑변으로 합성되고, 그러면
   * 라벨보다 눈에 띄게 아래로 내려앉는다.
   */
  align?: 'baseline' | 'top' | 'center';
  children: React.ReactNode;
}) {
  const labelClass = `${LABEL_W} shrink-0 ${
    align === 'top' ? 'pt-1.5' : ''
  } text-muted-foreground`;

  const alignClass =
    align === 'top'
      ? 'items-start'
      : align === 'center'
        ? 'items-center'
        : 'items-baseline';

  return (
    <div className={`flex gap-3 ${alignClass}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <dt className={labelClass}>{label}</dt>
      )}
      {htmlFor ? (
        <div className="min-w-0 flex-1">{children}</div>
      ) : (
        <dd
          className={`flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5 ${
            align === 'center' ? 'items-center' : 'items-baseline'
          }`}
        >
          {children}
        </dd>
      )}
    </div>
  );
}
