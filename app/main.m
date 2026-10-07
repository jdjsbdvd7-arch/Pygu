#import <UIKit/UIKit.h>

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) UILabel *clock;
@property (nonatomic, strong) UILabel *countLabel;
@property (nonatomic, assign) NSInteger count;
@end

@implementation AppDelegate

- (void)tick {
  NSDateFormatter *fmt = [NSDateFormatter new];
  fmt.dateFormat = @"HH:mm:ss";
  self.clock.text = [fmt stringFromDate:[NSDate date]];
}

- (void)tapped {
  self.count += 1;
  self.countLabel.text = [NSString stringWithFormat:@"Taps %ld", (long)self.count];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
  CGRect frame = UIScreen.mainScreen.bounds;
  self.window = [[UIWindow alloc] initWithFrame:frame];
  UIViewController *controller = [UIViewController new];
  controller.view.backgroundColor = [UIColor colorWithRed:0.06 green:0.07 blue:0.09 alpha:1];
  self.clock = [[UILabel alloc] initWithFrame:CGRectMake(0, 120, frame.size.width, 80)];
  self.clock.textColor = UIColor.whiteColor;
  self.clock.textAlignment = NSTextAlignmentCenter;
  self.clock.font = [UIFont monospacedDigitSystemFontOfSize:42 weight:UIFontWeightSemibold];
  [controller.view addSubview:self.clock];
  self.countLabel = [[UILabel alloc] initWithFrame:CGRectMake(0, 220, frame.size.width, 40)];
  self.countLabel.text = @"Taps 0";
  self.countLabel.textColor = UIColor.whiteColor;
  self.countLabel.textAlignment = NSTextAlignmentCenter;
  [controller.view addSubview:self.countLabel];
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  button.frame = CGRectMake(48, 320, frame.size.width - 96, 64);
  button.backgroundColor = [UIColor colorWithRed:0.79 green:0.54 blue:0.23 alpha:1];
  [button setTitle:@"Tap" forState:UIControlStateNormal];
  [button setTitleColor:UIColor.blackColor forState:UIControlStateNormal];
  button.titleLabel.font = [UIFont systemFontOfSize:22 weight:UIFontWeightSemibold];
  button.layer.cornerRadius = 16;
  [button addTarget:self action:@selector(tapped) forControlEvents:UIControlEventTouchUpInside];
  [controller.view addSubview:button];
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  [NSTimer scheduledTimerWithTimeInterval:1 target:self selector:@selector(tick) userInfo:nil repeats:YES];
  [self tick];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
