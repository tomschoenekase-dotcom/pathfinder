type PathFinderBrandProps = {
  className?: string
  textClassName?: string
}

export function PathFinderBrand({ className = '' }: PathFinderBrandProps) {
  return (
    <div className={`flex items-center ${className}`}>
      <img src="/pathfinder-logo.png" alt="PathFinder" className="h-9 w-auto" />
    </div>
  )
}
